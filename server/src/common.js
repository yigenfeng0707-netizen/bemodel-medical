import crypto from 'node:crypto';
import { config } from './config.js';

// ---------- 统一信封 ----------
export class BizException extends Error {
  constructor(msg) { super(msg); this.name = 'BizException'; }
}
export const ok = (data = null) => ({ code: 0, msg: 'ok', data });
export const fail = (msg) => ({ code: 500, msg, data: null });

export function pageResult(list, total, pageNum, pageSize) {
  return { list, total, pageNum, pageSize };
}
export function normPage(pageNum, pageSize, def = 20) {
  const p = Math.max(1, parseInt(pageNum || '1', 10) || 1);
  const s = Math.min(200, Math.max(1, parseInt(pageSize || String(def), 10) || def));
  return { p, s };
}

// ---------- 建模元素统一状态机（规则/动作/文档/知识条目通用） ----------
export const SM_TRANSITIONS = {
  DRAFT: ['REVIEW', 'DEPRECATED'],
  REVIEW: ['PUBLISHED', 'DRAFT', 'DEPRECATED'],
  PUBLISHED: ['DEPRECATED'],
  DEPRECATED: ['DRAFT'],
};
export const SM_ACTION = { REVIEW: '提交评审', PUBLISHED: '发布', DEPRECATED: '废弃', DRAFT: '退回草稿' };
export function checkTransition(current, target) {
  if (!SM_TRANSITIONS[current] || !SM_TRANSITIONS[current].includes(target)) {
    throw new BizException(`非法状态流转：${current} → ${target}`);
  }
}
export function nextActionsOf(status) {
  return (SM_TRANSITIONS[status] || []).map(t => ({ target: t, label: SM_ACTION[t] }));
}

// ---------- 脱敏（三类出口同一口径：API 行 / 持久化载荷 / 送 LLM 提示词） ----------
export function isNameKey(key) {
  if (!key) return false;
  const k = String(key).toLowerCase();
  return ['patient_name', 'patient', 'pat_name', '姓名'].includes(k) || k.includes('姓名');
}
export function maskName(name) {
  if (name == null || name === '') return '*';
  const s = String(name);
  if (s.length <= 1) return '*';
  if (s.length === 2) return s[0] + '*';
  return s[0] + '*' + s[s.length - 1];
}
export function maskPatientRow(row) {
  const out = { ...row };
  for (const k of Object.keys(out)) if (isNameKey(k)) out[k] = maskName(out[k]);
  return out;
}
export function maskPatientRows(rows) { return (rows || []).map(maskPatientRow); }

// ---------- AES-256-GCM（数据源密码等敏感字段） ----------
function deriveKey() { return crypto.createHash('sha256').update(config.appSecretKey, 'utf8').digest(); }
export function encryptSecret(plain) {
  if (plain == null || String(plain).startsWith('ENC:')) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return 'ENC:' + Buffer.concat([iv, enc, cipher.getAuthTag()]).toString('base64');
}
export function decryptSecret(stored) {
  if (stored == null || !String(stored).startsWith('ENC:')) return stored;
  try {
    const raw = Buffer.from(String(stored).slice(4), 'base64');
    const iv = raw.subarray(0, 12);
    const data = raw.subarray(12, raw.length - 16);
    const tag = raw.subarray(raw.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (e) {
    throw new Error('密文解密失败：密钥不匹配或数据损坏');
  }
}

// ---------- SqlGuard：管理端可信探针 SQL 的只读守卫 ----------
const GUARD_FORBIDDEN = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE', 'REPLACE', 'MERGE', 'CALL', 'SET', 'LOCK', 'UNLOCK', 'RENAME', 'KILL', 'SHUTDOWN', 'ATTACH', 'DETACH', 'PRAGMA'];
export function stripComments(sql) {
  return String(sql || '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}
export function requireReadOnly(sql, label = 'SQL') {
  const s = stripComments(sql).trim().replace(/;+\s*$/, '');
  if (!s) throw new BizException(`${label} 不能为空`);
  if (!/^(SELECT|WITH)\b/i.test(s)) throw new BizException(`${label} 只允许 SELECT/WITH 只读查询`);
  const upper = ' ' + s.toUpperCase() + ' ';
  for (const kw of GUARD_FORBIDDEN) {
    if (new RegExp(`\\b${kw}\\b`).test(upper)) throw new BizException(`${label} 含被禁止的关键字 ${kw}`);
  }
  if (/\bFOR\s+(UPDATE|SHARE)\b/i.test(s)) throw new BizException(`${label} 不允许 FOR UPDATE/SHARE`);
  return s;
}
// 末级 LIMIT 钳制
export function clampLimit(sql, maxRows) {
  const s = requireReadOnly(sql);
  const m = s.match(/\bLIMIT\s+(\d+)\s*(?:,\s*(\d+)|OFFSET\s+(\d+))?\s*;?\s*$/i);
  if (!m) return s + ` LIMIT ${maxRows}`;
  const b = m[2] ?? m[3];
  const n = parseInt(b ?? m[1], 10);
  if (n <= maxRows) return s;
  return s.slice(0, m.index) + `LIMIT ${maxRows}`;
}

// ---------- LLM 生成 SQL 的白名单校验（表/列白名单沙箱） ----------
const SQL_KEYWORDS = new Set(('SELECT FROM WHERE GROUP BY ORDER HAVING LIMIT OFFSET AS ON AND OR NOT NULL IS IN LIKE BETWEEN EXISTS CASE WHEN THEN ELSE END JOIN LEFT RIGHT INNER OUTER CROSS UNION ALL DISTINCT COUNT SUM AVG MIN MAX COALESCE IFNULL ROUND CAST STRFTIME DATE DATETIME JULIANDAY TOTAL UPPER LOWER LENGTH SUBSTR TRIM ABS INTEGER TEXT REAL DESC ASC VALUES WITH %.').split(/\s+/));
export function validateSql(rawSql, allowedTables, allowedColumns) {
  // 原文（保留字面量，仅去注释）——最终执行与返回的都是它
  let orig = String(rawSql || '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;+\s*$/, '');
  // 校验副本：字符串字面量替换为空格（防关键字藏进字符串），反引号保留标识符
  const chk = orig.replace(/'(?:[^']|'')*'/g, ' ').replace(/"(?:[^"]|"")*"/g, ' ');
  if (!orig) throw new BizException('SQL 为空');
  if (orig.includes(';')) throw new BizException('SQL 校验失败：禁止多语句');
  if (!/^SELECT\b/i.test(orig)) throw new BizException('SQL 校验失败：仅允许 SELECT 查询');
  const upper = ' ' + chk.toUpperCase() + ' ';
  for (const kw of ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE', 'GRANT', 'REVOKE', 'REPLACE', 'LOAD', 'CALL', 'EXEC', 'EXECUTE', 'HANDLER', 'LOCK', 'UNLOCK', 'SET', 'INTO', 'OUTFILE', 'ATTACH', 'DETACH', 'PRAGMA']) {
    if (new RegExp(`\\b${kw}\\b`).test(upper)) throw new BizException(`SQL 校验失败：含被禁止的关键字 ${kw}`);
  }
  // 表白名单：FROM/JOIN 后的表名
  const tables = new Set(allowedTables.map(t => t.toLowerCase()));
  const tableRe = /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  let m;
  while ((m = tableRe.exec(chk))) {
    if (!tables.has(m[1].toLowerCase())) throw new BizException(`SQL 校验失败：表 ${m[1]} 不在映射白名单`);
  }
  // 收集别名
  const aliases = new Set();
  const aliasRe = /\bAS\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  while ((m = aliasRe.exec(chk))) aliases.add(m[1].toLowerCase());
  const tblAliasRe = /\b(?:FROM|JOIN)\s+[a-zA-Z_][a-zA-Z0-9_]*\s+([a-zA-Z_][a-zA-Z0-9_]*)\b/gi;
  while ((m = tblAliasRe.exec(chk))) if (!SQL_KEYWORDS.has(m[1].toUpperCase())) aliases.add(m[1].toLowerCase());
  const colAliasRe = /(?:\)|\*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:,|FROM\b|$)/gi;
  while ((m = colAliasRe.exec(chk))) if (!SQL_KEYWORDS.has(m[1].toUpperCase())) aliases.add(m[1].toLowerCase());
  // 列白名单：所有标识符必须在 关键词/别名/表/列 白名单内
  const cols = new Set(allowedColumns.map(c => c.toLowerCase()));
  const tablesLC = new Set(allowedTables.map(t => t.toLowerCase()));
  const identRe = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b(\s*\.\s*([a-zA-Z_][a-zA-Z0-9_]*))?/g;
  while ((m = identRe.exec(chk))) {
    const [full, a, , b] = m;
    const aLC = a.toLowerCase();
    if (b) {
      if (!aliases.has(aLC) && !tablesLC.has(aLC)) throw new BizException(`SQL 校验失败：未知标识符 ${a}`);
      if (!cols.has(b.toLowerCase()) && !tablesLC.has(b.toLowerCase()) && !SQL_KEYWORDS.has(b.toUpperCase())) {
        throw new BizException(`SQL 校验失败：列 ${b} 不在映射白名单`);
      }
    } else if (!SQL_KEYWORDS.has(aLC.toUpperCase()) && !aliases.has(aLC) && !cols.has(aLC) && !tablesLC.has(aLC)) {
      // 函数调用放行（后随 "("）
      const after = chk.slice(m.index + full.length).trimStart();
      if (!after.startsWith('(')) throw new BizException(`SQL 校验失败：标识符 ${a} 不在白名单`);
    }
  }
  // LIMIT 钳制（在原文上，兼容 MySQL 的 LIMIT a,b 形式）
  const lim = orig.match(/\bLIMIT\s+(\d+)\s*(?:,\s*(\d+)|OFFSET\s+(\d+))?\s*$/i);
  if (lim) {
    if (lim[2]) return orig.slice(0, lim.index) + `LIMIT ${Math.min(100, parseInt(lim[2], 10))} OFFSET ${lim[1]}`;
    const n = parseInt(lim[1], 10);
    if (n > 100) return orig.slice(0, lim.index) + 'LIMIT 100';
    return orig;
  }
  return orig + ' LIMIT 100';
}

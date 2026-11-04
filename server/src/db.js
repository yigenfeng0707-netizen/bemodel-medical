import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const platform = new DatabaseSync(config.platformDb);
platform.exec('PRAGMA journal_mode=WAL;');
platform.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

// ---------- 演示/业务库注册表（数据不搬家：平台只持有连接与元数据） ----------
const bizCache = new Map();

export function businessDb(dsCode) {
  if (bizCache.has(dsCode)) return bizCache.get(dsCode);
  const file = config.demoDbs[dsCode];
  if (!file || !fs.existsSync(file)) throw new Error(`数据源 ${dsCode} 的库文件不存在`);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL;');
  bizCache.set(dsCode, db);
  return db;
}

export function businessDbByFile(file) {
  const abs = path2(file);
  for (const [k, v] of Object.entries(config.demoDbs)) {
    if (path2(v) === abs) return { dsCode: k, db: businessDb(k) };
  }
  const db = new DatabaseSync(abs);
  db.exec('PRAGMA journal_mode=WAL;');
  return { dsCode: null, db };
}
function path2(p) { return String(p).replace(/\\/g, '/').toLowerCase(); }

export function biz(dsCode) {
  try { return businessDb(dsCode); } catch { return null; }
}

// 在业务库上执行只读探针 SQL（queryForObject 单值 / rows 多行）
export function probeOne(dsCode, sql, params = []) {
  const row = businessDb(dsCode).prepare(sql).get(...params);
  if (!row) return null;
  const v = Object.values(row)[0];
  return v === null || v === undefined ? null : v;
}
export function probeRows(dsCode, sql, params = [], maxRows = 100) {
  return businessDb(dsCode).prepare(sql + (/\blimit\b/i.test(sql) ? '' : ` LIMIT ${maxRows}`)).all(...params);
}
export function probeCount(dsCode, sql, params = []) {
  const v = probeOne(dsCode, sql, params);
  return v === null ? 0 : Number(v);
}

// ---------- 通用小工具 ----------
export function now() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
export function dateOf(d = new Date()) { return now().slice(0, 10); }
export function addDays(base, days) { const d = new Date(base); d.setDate(d.getDate() + days); return d; }
export function fmtDate(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function fmtDateTime(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${fmtDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

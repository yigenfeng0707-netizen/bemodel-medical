import express from 'express';
import fs from 'node:fs';
import { platform, now, businessDb } from './db.js';
import { config } from './config.js';
import { BizException, ok, encryptSecret, decryptSecret, maskPatientRow, isNameKey } from './common.js';
import { currentUser } from './auth.js';
import { chat, parseJsonLoose } from './llm.js';
import { recordMiss } from './ontology.js';

export const datasourceRouter = express.Router();
const R = datasourceRouter;

// ---------- 数据源注册 ----------
function maskDs(d) { return { ...d, password: '****' }; }
R.get('/list', (req, res) => {
  res.json(ok(platform.prepare('SELECT * FROM bm_datasource ORDER BY id').all().map(maskDs)));
});
R.post('/', (req, res) => {
  const b = req.body || {};
  if (!b.dsCode || !b.dsName) throw new BizException('编码与名称不能为空');
  if (platform.prepare('SELECT 1 FROM bm_datasource WHERE ds_code=?').get(b.dsCode)) throw new BizException('数据源编码已存在');
  // 复现版数据源 = SQLite 库文件（数据不搬家：平台只登记与映射，不复制数据）
  const file = config.demoDbs[b.dsCode] || b.db_name;
  if (!file || !fs.existsSync(file)) throw new BizException(`库文件不存在：${file}（演示库须先由 DataSeeder 生成）`);
  platform.prepare('INSERT INTO bm_datasource(ds_code,ds_name,product_name,db_type,host,port,db_name,username,password) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(b.dsCode, b.dsName, b.productName || '', 'SQLITE', '127.0.0.1', 0, file, b.username || 'demo', encryptSecret('demo'));
  res.json(ok(maskDs(platform.prepare('SELECT * FROM bm_datasource WHERE ds_code=?').get(b.dsCode))));
});
R.post('/test', (req, res) => {
  const b = req.body || {};
  try {
    const ds = platform.prepare('SELECT * FROM bm_datasource WHERE ds_code=?').get(b.dsCode);
    const file = ds ? ds.db_name : (config.demoDbs[b.dsCode] || b.db_name);
    const db = businessDbByFile2(file);
    db.prepare('SELECT 1').get();
    res.json(ok(true));
  } catch (e) { res.json(ok(false)); }
});
function businessDbByFile2(file) {
  if (file && fs.existsSync(file)) return businessDb(resolveDsByFile(file));
  throw new Error('库文件不存在');
}
function resolveDsByFile(file) {
  for (const [k, v] of Object.entries(config.demoDbs)) if (v === file || v.endsWith(String(file))) return k;
  return file;
}

// ---------- 物理快照扫描（等价 information_schema 扫描） ----------
R.post('/scan/:dsCode', (req, res) => {
  const dsCode = req.params.dsCode;
  const db = businessDb(dsCode);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name").all();
  const delT = platform.prepare('DELETE FROM bm_physical_table WHERE ds_code=?');
  const delC = platform.prepare('DELETE FROM bm_physical_column WHERE ds_code=?');
  const insT = platform.prepare('INSERT INTO bm_physical_table(ds_code,table_name,table_comment,scanned_at) VALUES (?,?,?,?)');
  const insC = platform.prepare('INSERT INTO bm_physical_column(ds_code,table_name,column_name,data_type,column_comment,is_pk,ordinal_position) VALUES (?,?,?,?,?,?,?)');
  delT.run(dsCode); delC.run(dsCode);
  const st = now();
  for (const t of tables) {
    insT.run(dsCode, t.name, '', st);
    const cols = db.prepare(`PRAGMA table_info(${t.name})`).all();
    cols.forEach((c, i) => insC.run(dsCode, t.name, c.name, c.type || 'TEXT', '', c.pk ? 1 : 0, i + 1));
  }
  res.json(ok({ dsCode, tableCount: tables.length }));
});
R.get('/tables/:dsCode', (req, res) => {
  res.json(ok(platform.prepare('SELECT * FROM bm_physical_table WHERE ds_code=? ORDER BY table_name').all(req.params.dsCode)));
});
R.get('/columns/:dsCode', (req, res) => {
  const { tableName } = req.query;
  const rows = tableName
    ? platform.prepare('SELECT * FROM bm_physical_column WHERE ds_code=? AND table_name=? ORDER BY ordinal_position').all(req.params.dsCode, tableName)
    : platform.prepare('SELECT * FROM bm_physical_column WHERE ds_code=? ORDER BY table_name, ordinal_position').all(req.params.dsCode);
  res.json(ok(rows));
});

// ---------- 语义映射 ----------
R.get('/mapping/list', (req, res) => {
  const { dsCode, tableName, status } = req.query;
  let sql = 'SELECT * FROM bm_mapping WHERE 1=1';
  const params = [];
  if (dsCode) { sql += ' AND ds_code=?'; params.push(dsCode); }
  if (tableName) { sql += ' AND table_name=?'; params.push(tableName); }
  if (status) { sql += ' AND status=?'; params.push(status); }
  sql += ' ORDER BY ds_code, table_name, column_name, id';
  res.json(ok(platform.prepare(sql).all(...params)));
});
function logMapping(mappingId, action, before, after) {
  platform.prepare('INSERT INTO bm_mapping_log(mapping_id,action,before_json,after_json,operator) VALUES (?,?,?,?,?)')
    .run(mappingId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, currentUser(null)?.username || 'system');
}
function logMappingReq(mappingId, action, before, after, username) {
  platform.prepare('INSERT INTO bm_mapping_log(mapping_id,action,before_json,after_json,operator) VALUES (?,?,?,?,?)')
    .run(mappingId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, username);
}
R.post('/mapping/batch', (req, res) => {
  const list = Array.isArray(req.body) ? req.body : [];
  const user = currentUser(req)?.username || '';
  let n = 0;
  for (const b of list) {
    if (!b.dsCode || !b.tableName || !b.columnName || !b.conceptCode) continue;
    let status = b.status;
    if (!status) status = b.source === 'AI' ? 'PROPOSED' : 'ACTIVE'; // AI 落提议待审，人工直接生效
    if (!['PROPOSED', 'ACTIVE', 'DEPRECATED'].includes(status)) throw new BizException(`非法映射状态 ${status}`);
    const exist = platform.prepare('SELECT * FROM bm_mapping WHERE ds_code=? AND table_name=? AND column_name=? AND concept_code=? AND attr_code=?')
      .get(b.dsCode, b.tableName, b.columnName, b.conceptCode, b.attrCode || '');
    if (exist) {
      const before = { ...exist };
      const nextStatus = exist.status === 'ACTIVE' && status === 'PROPOSED' ? 'PROPOSED' : status; // 生效内容变更须重新生效
      platform.prepare('UPDATE bm_mapping SET value_map=?, confirmed=?, source=?, status=?, updated_by=?, updated_at=? WHERE id=?')
        .run(b.valueMap || null, b.confirmed ? 1 : 0, b.source || 'MANUAL', nextStatus, user, now(), exist.id);
      logMappingReq(exist.id, 'UPDATE', before, platform.prepare('SELECT * FROM bm_mapping WHERE id=?').get(exist.id), user);
    } else {
      const r = platform.prepare(`INSERT INTO bm_mapping(ds_code,table_name,column_name,concept_code,attr_code,value_map,confirmed,source,status,updated_by,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(b.dsCode, b.tableName, b.columnName, b.conceptCode, b.attrCode || '', b.valueMap || null, b.confirmed ? 1 : 0, b.source || 'MANUAL', status, user, now());
      logMappingReq(r.lastInsertRowid, 'CREATE', null, platform.prepare('SELECT * FROM bm_mapping WHERE id=?').get(r.lastInsertRowid), user);
    }
    n++;
  }
  res.json(ok(n));
});
R.put('/mapping/:id', (req, res) => {
  const old = platform.prepare('SELECT * FROM bm_mapping WHERE id=?').get(req.params.id);
  if (!old) throw new BizException('映射不存在');
  const before = { ...old };
  platform.prepare('UPDATE bm_mapping SET concept_code=?, attr_code=?, value_map=?, confirmed=?, updated_by=?, updated_at=? WHERE id=?')
    .run(req.body.conceptCode ?? old.concept_code, req.body.attrCode ?? old.attr_code, req.body.valueMap ?? old.value_map,
      (req.body.confirmed ?? old.confirmed) ? 1 : 0, currentUser(req)?.username || '', now(), req.params.id);
  logMappingReq(old.id, 'UPDATE', before, platform.prepare('SELECT * FROM bm_mapping WHERE id=?').get(old.id), currentUser(req)?.username || '');
  res.json(ok(platform.prepare('SELECT * FROM bm_mapping WHERE id=?').get(old.id)));
});
R.post('/mapping/:id/transition', (req, res) => {
  const old = platform.prepare('SELECT * FROM bm_mapping WHERE id=?').get(req.params.id);
  if (!old) throw new BizException('映射不存在');
  const target = req.body?.target || req.query.target;
  const allowed = { PROPOSED: ['ACTIVE'], ACTIVE: ['DEPRECATED'], DEPRECATED: ['ACTIVE'] };
  if (!allowed[old.status]?.includes(target)) throw new BizException(`非法映射生命周期流转：${old.status} → ${target}`);
  platform.prepare('UPDATE bm_mapping SET status=?, updated_by=?, updated_at=? WHERE id=?').run(target, currentUser(req)?.username || '', now(), old.id);
  logMappingReq(old.id, 'TRANSITION', old, platform.prepare('SELECT * FROM bm_mapping WHERE id=?').get(old.id), currentUser(req)?.username || '');
  res.json(ok(platform.prepare('SELECT * FROM bm_mapping WHERE id=?').get(old.id)));
});
R.get('/mapping/:id/log', (req, res) => {
  res.json(ok(platform.prepare('SELECT * FROM bm_mapping_log WHERE mapping_id=? ORDER BY id DESC').all(req.params.id)));
});
R.delete('/mapping/:id', (req, res) => {
  const old = platform.prepare('SELECT * FROM bm_mapping WHERE id=?').get(req.params.id);
  if (old) {
    logMappingReq(old.id, 'DELETE', old, null, currentUser(req)?.username || '');
    platform.prepare('DELETE FROM bm_mapping WHERE id=?').run(old.id);
  }
  res.json(ok(true));
});

// ---------- AI 推荐绑定 ----------
function topKConcepts(columns) {
  const k = config.mapping.topKConcepts;
  const concepts = platform.prepare("SELECT code, name, domain_code FROM bm_concept WHERE status='PUBLISHED'").all();
  if (k <= 0 || concepts.length <= k) return concepts;
  const attrs = platform.prepare("SELECT concept_code, attr_code, attr_name FROM bm_attribute").all();
  const terms = platform.prepare('SELECT term, concept_code FROM bm_term').all();
  const byConcept = new Map();
  for (const c of concepts) byConcept.set(c.code, { needles: [], valid: 0 });
  const addNeedle = (code, n) => {
    const g = byConcept.get(code);
    if (!g || !n || String(n).length < 2) return;
    g.needles.push(String(n).toLowerCase());
    g.valid++;
  };
  for (const c of concepts) {
    addNeedle(c.code, c.code);
    c.code.split('_').forEach(w => addNeedle(c.code, w));
    addNeedle(c.code, c.name);
  }
  for (const a of attrs) { addNeedle(a.concept_code, a.attr_code); a.attr_code.split('_').forEach(w => addNeedle(a.concept_code, w)); addNeedle(a.concept_code, a.attr_name); }
  for (const t of terms) addNeedle(t.concept_code, t.term);
  const scored = [];
  for (const [code, g] of byConcept) {
    let score = 0;
    for (const col of columns) {
      const hay = `${col.column_name}`.toLowerCase() + ' ' + (col.column_comment || '').toLowerCase();
      let hits = 0;
      for (const n of g.needles) if (hay.includes(n)) hits++;
      if (g.valid > 0) score += hits / g.valid;
    }
    if (score > 0) scored.push({ code, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const keep = new Set(scored.slice(0, k).map(s => s.code));
  return concepts.filter(c => keep.has(c.code));
}
R.get('/mapping/ai-suggest', async (req, res) => {
  const { dsCode, tableName } = req.query;
  if (!dsCode || !tableName) throw new BizException('dsCode 与 tableName 必填');
  const columns = platform.prepare('SELECT * FROM bm_physical_column WHERE ds_code=? AND table_name=? ORDER BY ordinal_position').all(dsCode, tableName);
  if (!columns.length) throw new BizException('物理列不存在，请先扫描数据源');
  const concepts = platform.prepare("SELECT code, name, domain_code FROM bm_concept WHERE status='PUBLISHED' ORDER BY code").all();
  const attrs = platform.prepare('SELECT concept_code, attr_code, attr_name, data_type FROM bm_attribute ORDER BY sort').all();
  const terms = platform.prepare('SELECT term, concept_code FROM bm_term').all();
  const chosen = topKConcepts(columns);
  const chosenSet = new Set(chosen.map(c => c.code));
  const attrByConcept = new Map();
  for (const a of attrs) if (chosenSet.has(a.concept_code)) (attrByConcept.get(a.concept_code) || attrByConcept.set(a.concept_code, []).get(a.concept_code)).push(a);
  const conceptLines = chosen.map(c => `概念 ${c.code}(${c.name}): ${(attrByConcept.get(c.code) || []).map(a => `${a.attr_code}(${a.attr_name})`).join(', ') || '（无属性）'}`).join('\n');
  const colLines = columns.map(c => `- ${c.column_name} (${c.data_type})`).join('\n');

  let suggestions = null, llmUsed = false, failedBatches = 0, model = null;
  const llm = await chat('MAPPING_SUGGEST',
    '你是医疗信息化本体映射专家。只返回 JSON 数组，不要多余文字。',
    `物理表 ${tableName} 的字段：\n${colLines}\n\n可选标准概念及属性（已预筛 Top-K，共 ${concepts.length} 个概念）：\n${conceptLines}\n\n方言术语：${terms.map(t => `${t.term}→${t.concept_code}`).join('、')}\n\n请为每个物理字段推荐映射，返回 JSON 数组，元素格式：{"column":"字段名","conceptCode":"概念编码","attrCode":"属性编码","confidence":0.0-1.0,"reason":"理由"}。无合适映射时 attrCode 填 null。只返回 JSON。`);
  if (llm) {
    const parsed = parseJsonLoose(llm);
    if (Array.isArray(parsed) && parsed.length) {
      llmUsed = true;
      model = 'llm';
      const colSet = new Set(columns.map(c => c.column_name));
      suggestions = parsed.filter(s => colSet.has(s.column)).map(s => ({
        column: s.column, conceptCode: s.conceptCode || '', attrCode: s.attrCode || '',
        confidence: typeof s.confidence === 'number' ? s.confidence : 0.5, reason: s.reason || '',
      }));
    }
  }
  if (!suggestions) {
    failedBatches = 1;
    suggestions = columns.map(col => {
      const colLC = col.column_name.toLowerCase();
      let best = null;
      for (const c of concepts) {
        for (const a of attrs.filter(x => x.concept_code === c.code)) {
          if (colLC.includes(a.attr_code.toLowerCase()) || (colLC.includes(a.attr_name.toLowerCase()) && a.attr_name.length >= 2)) {
            if (!best) best = { column: col.column_name, conceptCode: c.code, attrCode: a.attr_code, confidence: 0.6, reason: '规则匹配：列名/注释与属性相似' };
          }
        }
      }
      return best || { column: col.column_name, conceptCode: '', attrCode: '', confidence: 0.0, reason: '未匹配，请人工指定' };
    });
  }
  // 本体增长回路：无候选概念的列记 miss
  for (const s of suggestions) {
    if (!s.conceptCode) recordMiss(s.column, 'ATTRIBUTE', 'MAPPING_AI');
  }
  res.json(ok({ llmUsed, failedBatches, model, suggestions }));
});

// ---------- 实例浏览（概念 → ACTIVE 映射 → 物理行投影） ----------
R.get('/instance/:conceptCode', (req, res) => {
  const code = req.params.conceptCode;
  const { tableName, pageNum = 1, pageSize = 20 } = req.query;
  const concept = platform.prepare('SELECT * FROM bm_concept WHERE code=?').get(code);
  if (!concept) throw new BizException('概念不存在');
  if (concept.status === 'DEPRECATED') throw new BizException('概念已废弃，实例不可投影');
  const attrs = platform.prepare('SELECT * FROM bm_attribute WHERE concept_code=? ORDER BY sort').all(code);
  const attrName = new Map(attrs.map(a => [a.attr_code, a.attr_name]));
  const mappings = platform.prepare("SELECT * FROM bm_mapping WHERE concept_code=? AND status='ACTIVE'").all(code);
  const byTable = new Map();
  for (const m of mappings) {
    const key = `${m.ds_code}@${m.table_name}`;
    if (!byTable.has(key)) byTable.set(key, { dsCode: m.ds_code, tableName: m.table_name, cols: [] });
    byTable.get(key).cols.push(m);
  }
  const sources = [...byTable.values()].sort((a, b) => b.cols.length - a.cols.length); // 映射多的主载体表优先
  const out = [];
  let p = Math.max(1, parseInt(pageNum, 10)), s = Math.min(100, Math.max(1, parseInt(pageSize, 10)));
  for (const src of sources) {
    let db; try { db = businessDb(src.dsCode); } catch { continue; }
    const cols = src.cols;
    const colSql = cols.map(c => c.column_name).join(', ');
    const total = db.prepare(`SELECT COUNT(*) c FROM ${src.tableName}`).get().c;
    const wantPage = !tableName || tableName === src.tableName;
    const sql = `SELECT ${colSql} FROM ${src.tableName}` + (wantPage ? ' LIMIT ? OFFSET ?' : ' LIMIT 5');
    const rows = wantPage ? db.prepare(sql).all(s, (p - 1) * s) : db.prepare(sql).all();
    const instances = rows.map(r => {
      const inst = {};
      for (const m of cols) {
        let v = r[m.column_name];
        if (m.value_map) {
          try { const vm = JSON.parse(m.value_map); if (vm && v !== null && vm[String(v)] !== undefined) v = vm[String(v)]; } catch { /* keep */ }
        }
        if (v === null || v === undefined) v = '-';
        inst[attrName.get(m.attr_code) || m.attr_code || m.column_name] = v;
      }
      return maskPatientRow(inst);
    });
    out.push({ dsCode: src.dsCode, tableName: src.tableName, totalRows: wantPage ? total : Math.min(total, 5), instances });
  }
  res.json(ok({ conceptCode: code, conceptName: concept.name, definition: concept.definition, sourceCount: out.length, sources: out }));
});

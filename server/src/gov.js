import express from 'express';
import { platform, now, businessDb, probeOne } from './db.js';
import { BizException, ok, clampLimit, maskPatientRow } from './common.js';
import { currentUser } from './auth.js';
import { evaluateMetric } from './metric.js';

export const govRouter = express.Router();
const G = govRouter;
export const reconcileRouter = express.Router();
const RC = reconcileRouter;

const SEVERITY_WEIGHT = { '高': 3, '中': 2, '低': 1 };

// ---------- 五类治理规则探针（编译为 SQL / Java 端比对） ----------
function probeRule(rule) {
  let expr;
  try { expr = JSON.parse(rule.expr_json); } catch { throw new Error('expr_json 解析失败'); }
  const db = (ds) => businessDb(ds);
  switch (expr.type) {
    case 'PK_UNIQUE': {
      const rows = db(expr.ds).prepare(`SELECT ${expr.column} AS value, COUNT(*) AS cnt FROM ${expr.table} GROUP BY ${expr.column} HAVING COUNT(*) > 1 LIMIT 5`).all();
      return { hits: rows.reduce((s, r) => s + r.cnt, 0), samples: rows };
    }
    case 'NOT_NULL': {
      const cond = expr.columns.map(c => `${c} IS NULL OR ${c} = ''`).join(' OR ');
      const cnt = db(expr.ds).prepare(`SELECT COUNT(*) c FROM ${expr.table} WHERE ${cond}`).get().c;
      const samples = db(expr.ds).prepare(`SELECT * FROM ${expr.table} WHERE ${cond} LIMIT 5`).all().map(maskPatientRow);
      return { hits: cnt, samples };
    }
    case 'DICT_CONSISTENT': {
      const dictRows = db(expr.dictDs).prepare(`SELECT DISTINCT ${expr.dictColumn} v FROM ${expr.dictTable}` +
        (expr.dictFilter ? ' WHERE ' + Object.entries(expr.dictFilter).map(([k]) => `${k} = ?`).join(' AND ') : ''))
        .all(...(expr.dictFilter ? Object.values(expr.dictFilter) : []));
      const dict = new Set(dictRows.map(r => String(r.v)));
      const rows = db(expr.ds).prepare(`SELECT ${expr.column} AS value, COUNT(*) AS cnt FROM ${expr.table} GROUP BY ${expr.column}`).all();
      const outliers = rows.filter(r => !dict.has(String(r.value)));
      return { hits: outliers.reduce((s, r) => s + r.cnt, 0), samples: outliers.slice(0, 5), detail: { dict: [...dict], actual: rows.map(r => r.value) } };
    }
    case 'REF_INTACT': {
      const refRows = db(expr.refDs).prepare(`SELECT DISTINCT ${expr.refColumn} v FROM ${expr.refTable} WHERE ${expr.refColumn} IS NOT NULL`).all();
      const refs = new Set(refRows.map(r => String(r.v)));
      const rows = db(expr.ds).prepare(`SELECT ${expr.column} AS value, COUNT(*) AS cnt FROM ${expr.table} WHERE ${expr.column} IS NOT NULL GROUP BY ${expr.column}`).all();
      const orphans = rows.filter(r => !refs.has(String(r.value)));
      return { hits: orphans.reduce((s, r) => s + r.cnt, 0), samples: orphans.slice(0, 5) };
    }
    case 'STOCK_BALANCE': {
      const stock = new Map(db(expr.ds).prepare(`SELECT ${expr.keyColumn} k, ${expr.qtyColumn} q FROM ${expr.stockTable}`).all().map(r => [String(r.k), r.q]));
      const inSum = new Map();
      for (const r of db(expr.ds).prepare(`SELECT ${expr.keyColumn} k, SUM(${expr.qtyColumn}) q FROM ${expr.inTable} GROUP BY ${expr.keyColumn}`).all()) inSum.set(String(r.k), r.q);
      const outSum = new Map();
      for (const r of db(expr.ds).prepare(`SELECT ${expr.keyColumn} k, SUM(${expr.qtyColumn}) q FROM ${expr.outTable} GROUP BY ${expr.keyColumn}`).all()) outSum.set(String(r.k), r.q);
      const bad = [];
      for (const [k, q] of stock) {
        const expect = (inSum.get(k) || 0) - (outSum.get(k) || 0);
        if (Number(q) !== Number(expect)) bad.push({ key: k, stock: q, expect });
      }
      return { hits: bad.length, samples: bad.slice(0, 5) };
    }
    default:
      throw new Error(`未知规则类型 ${expr.type}`);
  }
}

// ---------- 治理总览 / 表清单 / 扫描 ----------
G.get('/overview', (req, res) => {
  const tableCount = platform.prepare('SELECT COUNT(*) c FROM bm_physical_table').get().c;
  const columnCount = platform.prepare('SELECT COUNT(*) c FROM bm_physical_column').get().c;
  const mappedCols = platform.prepare("SELECT COUNT(DISTINCT ds_code || '@' || table_name || '@' || column_name) c FROM bm_mapping WHERE status='ACTIVE'").get().c;
  const lastScan = platform.prepare('SELECT * FROM bm_gov_scan ORDER BY id DESC LIMIT 1').get();
  const openIssues = platform.prepare("SELECT COUNT(*) c FROM bm_gov_issue WHERE status='未处理'").get().c;
  res.json(ok({
    tableCount, columnCount, mappedCount: mappedCols,
    coverage: columnCount ? Math.round(1000 * mappedCols / columnCount) / 10 : 0,
    qualityScore: lastScan?.quality_score ?? null, openIssues, lastScan: lastScan || null,
  }));
});
G.get('/tables', (req, res) => {
  const tables = platform.prepare(`
    SELECT t.ds_code, t.table_name, t.table_comment,
      (SELECT COUNT(*) FROM bm_physical_column c WHERE c.ds_code=t.ds_code AND c.table_name=t.table_name) col_count,
      (SELECT COUNT(DISTINCT column_name) FROM bm_mapping m WHERE m.ds_code=t.ds_code AND m.table_name=t.table_name AND m.status='ACTIVE') mapped_count
    FROM bm_physical_table t ORDER BY t.ds_code, t.table_name`).all();
  const out = [];
  for (const t of tables) {
    let rowCount = 0, domain = '未认领';
    try {
      rowCount = businessDb(t.ds_code).prepare(`SELECT COUNT(*) c FROM ${t.table_name}`).get().c;
    } catch { /* ignore */ }
    const domRow = platform.prepare("SELECT DISTINCT c.domain_code d FROM bm_mapping m JOIN bm_concept c ON c.code=m.concept_code WHERE m.ds_code=? AND m.table_name=? AND m.status='ACTIVE' LIMIT 1").get(t.ds_code, t.table_name);
    if (domRow) domain = domRow.d;
    const issueCount = platform.prepare("SELECT COUNT(*) c FROM bm_gov_issue WHERE ds_code=? AND table_name=? AND status='未处理'").get(t.ds_code, t.table_name).c;
    out.push({
      dsCode: t.ds_code, tableName: t.table_name, tableComment: t.table_comment, rowCount,
      colCount: t.col_count, mappedCount: t.mapped_count,
      coverage: t.col_count ? Math.round(100 * t.mapped_count / t.col_count) : 0,
      domain, issueCount, health: issueCount === 0 ? '优' : '良',
    });
  }
  out.sort((a, b) => b.issueCount - a.issueCount);
  res.json(ok(out));
});
G.post('/scan', (req, res) => {
  const started = Date.now();
  const rules = platform.prepare("SELECT * FROM bm_gov_rule WHERE status='PUBLISHED' ORDER BY rule_code").all();
  const issues = [];
  let totalWeight = 0, passedWeight = 0;
  for (const rule of rules) {
    const w = SEVERITY_WEIGHT[rule.severity] || 1;
    totalWeight += w;
    try {
      const r = probeRule(rule);
      if (r.hits > 0) {
        issues.push({ rule, hitCount: r.hits, samples: r.samples, detail: r.detail });
      } else passedWeight += w;
    } catch (e) {
      issues.push({ rule, hitCount: 1, samples: [{ probeError: e.message }], probeError: e.message });
    }
  }
  const qualityScore = totalWeight ? Math.round(100 * passedWeight / totalWeight) : 100;
  const s = platform.prepare('INSERT INTO bm_gov_scan(scan_time,duration_ms,rule_count,issue_count,quality_score) VALUES (?,?,?,?,?)')
    .run(now(), Date.now() - started, rules.length, issues.length, qualityScore);
  const ins = platform.prepare('INSERT INTO bm_gov_issue(scan_id,rule_code,rule_name,rule_type,severity,concept_code,ds_code,table_name,hit_count,sample_json) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (const it of issues) {
    ins.run(s.lastInsertRowid, it.rule.rule_code, it.rule.rule_name, it.rule.rule_type, it.rule.severity, it.rule.concept_code,
      JSON.parse(it.rule.expr_json).ds || JSON.parse(it.rule.expr_json).stockDs || null, JSON.parse(it.rule.expr_json).table || JSON.parse(it.rule.expr_json).stockTable || null,
      it.hitCount, JSON.stringify(it.samples || []));
  }
  res.json(ok({ scanId: s.lastInsertRowid, durationMs: Date.now() - started, ruleCount: rules.length, issueCount: issues.length, qualityScore }));
});
G.get('/issues', (req, res) => {
  const pageNum = Math.max(1, parseInt(req.query.pageNum || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || '20', 10)));
  const latest = platform.prepare('SELECT id FROM bm_gov_scan ORDER BY id DESC LIMIT 1').get();
  if (!latest) return res.json(ok({ list: [], total: 0, pageNum, pageSize }));
  const total = platform.prepare('SELECT COUNT(*) c FROM bm_gov_issue WHERE scan_id=?').get(latest.id).c;
  const list = platform.prepare('SELECT * FROM bm_gov_issue WHERE scan_id=? ORDER BY id LIMIT ? OFFSET ?').all(latest.id, pageSize, (pageNum - 1) * pageSize);
  res.json(ok({ list, total, pageNum, pageSize }));
});
G.post('/issues/:id/resolve', (req, res) => {
  platform.prepare("UPDATE bm_gov_issue SET status='已处理' WHERE id=?").run(req.params.id);
  res.json(ok(true));
});
G.post('/issues/:id/ticket', (req, res) => {
  const issue = platform.prepare('SELECT * FROM bm_gov_issue WHERE id=?').get(req.params.id);
  if (!issue) throw new BizException('问题不存在');
  const refNo = `T-GOV-${issue.rule_code}`;
  const exist = platform.prepare('SELECT id, ref_no FROM link_node WHERE ref_no=?').get(refNo);
  if (exist) return res.json(ok({ ticketId: exist.id, refNo, reused: true }));
  let payload = { ruleCode: issue.rule_code, hitCount: issue.hit_count };
  if (issue.rule_code === 'GOV-004') {
    payload.conceptCode = 'FEE_DETAIL';
    try {
      const sample = JSON.parse(issue.sample_json || '[]')[0];
      if (sample && sample.value) {
        const p = businessDb('DS_LIS').prepare('SELECT patient_no, patient_name FROM lab_apply WHERE apply_status=? LIMIT 1').get(sample.value);
        if (p) payload.inhos_no = p.patient_no, payload.patient = maskName(p.patient_name);
      }
    } catch { /* ignore */ }
  }
  const r = platform.prepare('INSERT INTO link_node(node_type,ref_no,title,concept_code,status,occurred_at,payload) VALUES (?,?,?,?,?,?,?)')
    .run('TICKET', refNo, `治理转办：${issue.rule_name}（命中 ${issue.hit_count}）`, issue.concept_code, '待处理', now(), JSON.stringify(payload));
  res.json(ok({ ticketId: r.lastInsertRowid, refNo, reused: false }));
});

// ---------- 对账组 ----------
RC.post('/', (req, res) => {
  const b = req.body || {};
  if (!b.groupCode || !b.name) throw new BizException('编码与名称不能为空');
  const codes = String(b.metricCodes || '').split(',').map(s => s.trim()).filter(Boolean);
  if (codes.length < 2) throw new BizException('至少选择 2 个口径指标');
  for (const c of codes) if (!platform.prepare('SELECT 1 FROM bm_metric WHERE metric_code=?').get(c)) throw new BizException(`指标 ${c} 不存在`);
  if (platform.prepare('SELECT 1 FROM bm_reconcile_group WHERE group_code=?').get(b.groupCode)) throw new BizException('对账组编码已存在');
  platform.prepare(`INSERT INTO bm_reconcile_group(group_code,name,definition,metric_codes,drill_ds_code,drill_sql,owner,dispute_status,buckets_json,scheduled)
    VALUES (?,?,?,?,?,?,?,'OPEN',?,?)`)
    .run(b.groupCode, b.name, b.definition || '', codes.join(','), b.drillDsCode || null, b.drillSql || null, b.owner || null, b.bucketsJson || null, b.scheduled ? 1 : 0);
  res.json(ok(true));
});
RC.put('/', (req, res) => {
  const g = platform.prepare('SELECT * FROM bm_reconcile_group WHERE group_code=?').get(req.body?.groupCode);
  if (!g) throw new BizException('对账组不存在');
  platform.prepare('UPDATE bm_reconcile_group SET name=?, definition=?, owner=?, metric_codes=?, drill_ds_code=?, drill_sql=?, buckets_json=?, scheduled=? WHERE id=?')
    .run(req.body.name ?? g.name, req.body.definition ?? g.definition, req.body.owner ?? g.owner, req.body.metricCodes ?? g.metric_codes,
      req.body.drillDsCode ?? g.drill_ds_code, req.body.drillSql ?? g.drill_sql, req.body.bucketsJson ?? g.buckets_json,
      (req.body.scheduled ?? g.scheduled) ? 1 : 0, g.id);
  res.json(ok(true));
});
RC.get('/list', (req, res) => {
  const groups = platform.prepare('SELECT * FROM bm_reconcile_group ORDER BY id').all();
  const out = groups.map(g => {
    const latest = platform.prepare('SELECT * FROM bm_reconcile_run WHERE group_code=? ORDER BY id DESC LIMIT 1').get(g.group_code);
    const history = platform.prepare('SELECT * FROM bm_reconcile_run WHERE group_code=? ORDER BY id DESC LIMIT 20').all(g.group_code);
    return { ...g, latest, history };
  });
  res.json(ok(out));
});
export function runReconcileGroup(groupCode) {
  const g = platform.prepare('SELECT * FROM bm_reconcile_group WHERE group_code=?').get(groupCode);
  if (!g) throw new BizException('对账组不存在');
  const codes = [...new Set(String(g.metric_codes).split(',').map(s => s.trim()).filter(Boolean))];
  const values = {}, errors = {};
  for (const c of codes) {
    try {
      const r = evaluateMetric(c);
      if (r.error) errors[c] = r.error;
      else values[c] = r.value;
    } catch (e) { errors[c] = e.message; }
  }
  const vals = Object.values(values).filter(v => v != null);
  const diff = errors && Object.keys(errors).length ? null : (vals.length ? Math.max(...vals) - Math.min(...vals) : null);
  // 分歧没消，工单不算完：重跑出非零差额自动打回 OPEN
  if (diff !== null && diff !== 0 && g.dispute_status !== 'OPEN') {
    platform.prepare("UPDATE bm_reconcile_group SET dispute_status='OPEN', dispute_owner=NULL, claimed_by=NULL, resolved_by=NULL WHERE id=?").run(g.id);
    g.dispute_status = 'OPEN';
  }
  // 归因桶
  let bucketsResult = null;
  if (g.buckets_json) {
    try {
      const buckets = JSON.parse(g.buckets_json);
      const results = [];
      let sum = 0, failed = 0;
      for (const b of buckets) {
        try {
          const cnt = Number(probeOne(b.dsCode, clampLimit(b.sql, 5))) || 0;
          results.push({ label: b.label, sign: b.sign, count: cnt });
          sum += (b.sign || 1) * (cnt || 0);
        } catch (e) {
          results.push({ label: b.label, sign: b.sign, error: e.message });
          failed++;
        }
      }
      bucketsResult = { buckets: results, sum, matchesDiff: failed === 0 && diff != null && diff === sum };
    } catch (e) {
      bucketsResult = { buckets: [], sum: 0, matchesDiff: false, error: `桶配置解析失败：${e.message}` };
    }
  }
  // 下钻
  let drillJson = null, drillCount = null;
  if (g.drill_sql && g.drill_ds_code) {
    try {
      const rows = businessDb(g.drill_ds_code).prepare(clampLimit(g.drill_sql, 200) + '').all().map(maskPatientRow);
      drillJson = JSON.stringify(rows.slice(0, 200));
      drillCount = rows.length;
    } catch (e) { drillCount = -1; }
  }
  platform.prepare('INSERT INTO bm_reconcile_run(group_code,values_json,diff_value,drill_json,drill_count,buckets_json,error_msg,ran_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(groupCode, JSON.stringify(values), diff, drillJson, drillCount, bucketsResult ? JSON.stringify(bucketsResult) : null,
      Object.keys(errors).length ? Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join('；') : null, now());
  return { values, diff, errors, bucketsResult, drillCount, disputeStatus: g.dispute_status };
}
RC.post('/run/:groupCode', (req, res) => {
  res.json(ok(runReconcileGroup(req.params.groupCode)));
});
RC.get('/compare/:groupCode', (req, res) => {
  const g = platform.prepare('SELECT * FROM bm_reconcile_group WHERE group_code=?').get(req.params.groupCode);
  if (!g) throw new BizException('对账组不存在');
  const codes = String(g.metric_codes).split(',').map(s => s.trim()).filter(Boolean);
  const left = codes.map(c => {
    const m = platform.prepare('SELECT * FROM bm_metric WHERE metric_code=?').get(c);
    const ev = evaluateMetric(c);
    return { metricCode: c, name: m?.name, sql: m?.probe_sql, value: ev.value, error: ev.error || null };
  });
  const latest = platform.prepare('SELECT * FROM bm_reconcile_run WHERE group_code=? ORDER BY id DESC LIMIT 1').get(g.group_code);
  res.json(ok({
    group: { ...g, buckets: g.buckets_json ? safeParse(g.buckets_json) : null },
    direct: left,
    platform: { latestRun: latest, disputeStatus: g.dispute_status, verdict: g.verdict, reusedBy: ['语义问数', 'AI 客服', 'MCP get_metric_card'] },
  }));
});
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
RC.post('/claim/:groupCode', (req, res) => {
  const g = platform.prepare('SELECT * FROM bm_reconcile_group WHERE group_code=?').get(req.params.groupCode);
  if (!g) throw new BizException('对账组不存在');
  if (g.dispute_status === 'RESOLVED') throw new BizException('已裁决，无需认领');
  if (g.dispute_status !== 'OPEN') throw new BizException(`已被 ${g.claimed_by || g.dispute_owner} 认领`);
  const user = currentUser(req)?.username;
  const r = platform.prepare("UPDATE bm_reconcile_group SET dispute_status='CLAIMED', claimed_by=?, dispute_owner=? WHERE group_code=? AND dispute_status='OPEN'")
    .run(user, user, req.params.groupCode);
  if (r.changes === 0) throw new BizException('认领失败：状态已变化');
  res.json(ok(true));
});
RC.post('/resolve/:groupCode', (req, res) => {
  const g = platform.prepare('SELECT * FROM bm_reconcile_group WHERE group_code=?').get(req.params.groupCode);
  if (!g) throw new BizException('对账组不存在');
  if (!['OPEN', 'CLAIMED'].includes(g.dispute_status)) throw new BizException('已裁决，不可静默覆盖');
  const { verdict, note } = req.body || {};
  if (!verdict) throw new BizException('裁决结论（以哪侧口径为准）必填');
  const user = currentUser(req)?.username;
  platform.prepare("UPDATE bm_reconcile_group SET dispute_status='RESOLVED', verdict=?, verdict_note=?, verdict_at=?, resolved_by=? WHERE group_code=? AND dispute_status IN ('OPEN','CLAIMED')")
    .run(verdict, note || null, now(), user, req.params.groupCode);
  res.json(ok(true));
});

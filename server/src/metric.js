import express from 'express';
import { platform, now, probeOne } from './db.js';
import { BizException, ok, requireReadOnly } from './common.js';

export const metricRouter = express.Router();
const R = metricRouter;

export async function getMetric(code) {
  return await platform.prepare('SELECT * FROM bm_metric WHERE metric_code=? OR name=?').get(code, code);
}

/** 指标实测：探针 SQL 只读守卫 → 到数据源执行取单值 → 回写 last_val；越限返回 alarm */
export async function evaluateMetric(code) {
  const m = await getMetric(code);
  if (!m) throw new BizException('指标不存在');
  if (!m.probe_sql || !m.ds_code) {
    return { metric: m, value: null, alarm: false, error: '该指标未绑定实测探针（ds_code/probe_sql）' };
  }
  try {
    const sql = requireReadOnly(m.probe_sql, '探针 SQL');
    const value = await probeOne(m.ds_code, sql);
    const v = value === null ? null : Number(value);
    await platform.prepare('UPDATE bm_metric SET last_val=?, last_eval_at=? WHERE id=?').run(v, now(), m.id);
    const alarm = m.warn_threshold != null && v != null && v > m.warn_threshold;
    return { metric: { ...m, last_val: v, last_eval_at: now() }, value: v, alarm };
  } catch (e) {
    return { metric: m, value: null, alarm: false, error: `探针执行失败：${e.message}` };
  }
}

R.get('/list', async (req, res) => {
  res.json(ok(await platform.prepare('SELECT * FROM bm_metric ORDER BY id').all()));
});
R.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.metricCode || !b.name) throw new BizException('编码与名称不能为空');
  if (await platform.prepare('SELECT 1 FROM bm_metric WHERE metric_code=?').get(b.metricCode)) throw new BizException('指标编码已存在');
  await platform.prepare('INSERT INTO bm_metric(metric_code,name,definition,formula,concept_code,owner,ds_code,probe_sql,warn_threshold) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(b.metricCode, b.name, b.definition || '', b.formula || '', b.conceptCode || null, b.owner || null, b.dsCode || null, b.probeSql || null, b.warnThreshold ?? null);
  res.json(ok(await platform.prepare('SELECT * FROM bm_metric WHERE metric_code=?').get(b.metricCode)));
});
// 口径卡编辑白名单（metricCode/lastVal 不可改）
R.put('/', async (req, res) => {
  const m = await getMetric(req.body?.metricCode);
  if (!m) throw new BizException('指标不存在');
  await platform.prepare('UPDATE bm_metric SET name=?, definition=?, formula=?, owner=?, concept_code=?, ds_code=?, probe_sql=?, warn_threshold=? WHERE id=?')
    .run(req.body.name ?? m.name, req.body.definition ?? m.definition, req.body.formula ?? m.formula, req.body.owner ?? m.owner,
      req.body.conceptCode ?? m.concept_code, req.body.dsCode ?? m.ds_code, req.body.probeSql ?? m.probe_sql,
      req.body.warnThreshold ?? m.warn_threshold, m.id);
  res.json(ok(await platform.prepare('SELECT * FROM bm_metric WHERE id=?').get(m.id)));
});
R.post('/evaluate/:metricCode', async (req, res) => {
  res.json(ok(await evaluateMetric(req.params.metricCode)));
});
R.post('/evaluate-all', async (req, res) => {
  const metrics = await platform.prepare('SELECT metric_code FROM bm_metric ORDER BY id').all();
  const results = [];
  for (const m of metrics) {
    const r = await evaluateMetric(m.metric_code);
    results.push({ metricCode: m.metric_code, name: r.metric.name, value: r.value, alarm: r.alarm, error: r.error || null });
  }
  res.json(ok(results));
});
export async function listProbed() {
  return await platform.prepare("SELECT * FROM bm_metric WHERE probe_sql IS NOT NULL AND probe_sql <> '' AND ds_code IS NOT NULL AND ds_code <> '' ORDER BY id").all();
}

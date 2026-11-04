// 治理 + 指标 + 对账组集成测试（隔离 DATA_DIR；HTTP 层：五类探针/质量分/工单转办/状态机/归因桶）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

const dir = path.resolve('data-test', 'gov');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.DATA_DIR = dir;

let app, server, adminToken, platform;

before(async () => {
  ({ platform } = await import('../src/db.js'));
  const { seedDemoDbs } = await import('../src/seed/demo.js');
  const { seedPlatformData } = await import('../src/seed/platform.js');
  const { govRouter, reconcileRouter } = await import('../src/gov.js');
  const { metricRouter } = await import('../src/metric.js');
  const { requireAuth, authorize, issueToken, seedUsers } = await import('../src/auth.js');

  assert.equal(seedDemoDbs(true), true);
  seedPlatformData();
  seedUsers();
  adminToken = issueToken(platform.prepare("SELECT * FROM bm_user WHERE username='admin'").get());

  app = express();
  app.use(express.json());
  app.use(requireAuth);
  app.use(authorize);
  app.use('/api/gov', govRouter);
  app.use('/api/reconcile', reconcileRouter);
  app.use('/api/metric', metricRouter);
  app.use((err, req, res, next) => { if (err) res.status(200).json({ code: 500, msg: err.message, data: null }); });

  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.on('listening', r));
});

after(() => server?.close());

async function call(method, url, body) {
  const port = server.address().port;
  const r = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + adminToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

test('治理扫描: 12 条规则全执行，预埋裂缝被命中（质量分<100）', async () => {
  const scan = await call('POST', '/api/gov/scan', {});
  assert.equal(scan.body.code, 0);
  assert.equal(scan.body.data.ruleCount, 12);
  assert.ok(scan.body.data.issueCount >= 1, '至少命中 GOV-004 状态字典裂缝');
  assert.ok(scan.body.data.qualityScore < 100);
  assert.ok(scan.body.data.qualityScore > 0);
  // 落表
  const issues = platform.prepare('SELECT * FROM bm_gov_issue WHERE scan_id=?').all(scan.body.data.scanId);
  assert.equal(issues.length, scan.body.data.issueCount);
  const g4 = issues.find(i => i.rule_code === 'GOV-004');
  assert.ok(g4, 'GOV-004 检验状态字典跨库一致被命中');
  assert.ok(g4.hit_count >= 1);
});

test('五类探针类型都被执行（PK_UNIQUE/NOT_NULL/DICT/REF_INTACT/STOCK_BALANCE）', async () => {
  const types = new Set(platform.prepare('SELECT DISTINCT rule_type t FROM bm_gov_rule').all().map(r => r.t));
  assert.deepEqual([...types].sort(), ['DICT_CONSISTENT', 'NOT_NULL', 'PK_UNIQUE', 'REF_INTACT', 'STOCK_BALANCE']);
});

test('问题清单: 分页返回最新一轮扫描结果', async () => {
  const r = await call('GET', '/api/gov/issues?pageNum=1&pageSize=5');
  assert.ok(r.body.data.total >= 1);
  assert.equal(r.body.data.list.length, Math.min(5, r.body.data.total));
});

test('治理转办: 幂等复用种子工单 T-GOV-GOV-004', async () => {
  const latest = platform.prepare('SELECT id FROM bm_gov_scan ORDER BY id DESC LIMIT 1').get();
  const issue = platform.prepare('SELECT id FROM bm_gov_issue WHERE scan_id=? AND rule_code=?').get(latest.id, 'GOV-004');
  const r1 = await call('POST', `/api/gov/issues/${issue.id}/ticket`, {});
  assert.equal(r1.body.data.reused, true, '种子已有同名工单 → 复用');
  const node = platform.prepare('SELECT * FROM link_node WHERE ref_no=?').get(r1.body.data.refNo);
  assert.equal(node.node_type, 'TICKET');
});

test('指标实测: CANCEL_NOT_REFUND = 5 笔裂缝，超阈值告警', async () => {
  const r = await call('POST', '/api/metric/evaluate/CANCEL_NOT_REFUND', {});
  assert.equal(r.body.data.value, 5);
  assert.equal(r.body.data.alarm, true, '阈值 0，实测 5 → 告警');
  // 回写 last_val
  const m = platform.prepare("SELECT last_val FROM bm_metric WHERE metric_code='CANCEL_NOT_REFUND'").get();
  assert.equal(m.last_val, 5);
});

test('只读守卫: 含写关键字的探针 SQL 被拒绝', async () => {
  const r = await call('POST', '/api/metric', { metricCode: 'M_BAD', name: '坏探针', dsCode: 'DS_HIS', probeSql: 'DELETE FROM medical_order' });
  // 创建成功，但评估时报只读守卫错误
  assert.equal(r.body.code, 0);
  const ev = await call('POST', '/api/metric/evaluate/M_BAD', {});
  assert.ok(ev.body.data.error.includes('只允许 SELECT'), ev.body.data.error);
});

test('对账组: 创建校验（<2 指标 / 未知指标 / 重码）', async () => {
  const a = await call('POST', '/api/reconcile', { groupCode: 'G1', name: 'x', metricCodes: 'ONLY_ONE' });
  assert.ok(a.body.msg.includes('至少选择 2 个'));
  const b = await call('POST', '/api/reconcile', { groupCode: 'G2', name: 'x', metricCodes: 'NOPE1,NOPE2' });
  assert.ok(b.body.msg.includes('NOPE1'));
  const c = await call('POST', '/api/reconcile', { groupCode: 'DISCHARGE_CLOSE', name: '重码', metricCodes: 'DISCHARGE_COUNT,SETTLE_COUNT' });
  assert.ok(c.body.msg.includes('已存在'));
});

test('对账执行: 双口径实测 + 差额 + 归因桶结构', async () => {
  // 种子组 DISCHARGE_CLOSE：HIS 出院人数 vs 结算笔数，预置 2 个归因桶
  const r = await call('POST', '/api/reconcile/run/DISCHARGE_CLOSE', {});
  assert.equal(r.body.code, 0);
  assert.ok(Object.keys(r.body.data.values).length === 2);
  assert.equal(typeof r.body.data.diff, 'number');
  assert.ok(r.body.data.bucketsResult.buckets.length === 2);
  assert.equal(typeof r.body.data.bucketsResult.sum, 'number');
  assert.equal(typeof r.body.data.bucketsResult.matchesDiff, 'boolean');
  // 运行记录落表
  const run = platform.prepare("SELECT * FROM bm_reconcile_run WHERE group_code='DISCHARGE_CLOSE' ORDER BY id DESC LIMIT 1").get();
  assert.ok(run.values_json.includes('DISCHARGE_COUNT'));
});

test('下钻: drill_sql 结果脱敏（患者姓名打码）', async () => {
  const r = await call('POST', '/api/reconcile/run/DISCHARGE_CLOSE', {});
  const run = platform.prepare("SELECT drill_json FROM bm_reconcile_run WHERE group_code='DISCHARGE_CLOSE' ORDER BY id DESC LIMIT 1").get();
  const rows = JSON.parse(run.drill_json);
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    if ('patient_name' in row) assert.ok(!String(row.patient_name).includes('国') || String(row.patient_name).includes('*'), '姓名应脱敏: ' + row.patient_name);
  }
});

test('对账状态机: OPEN→CLAIMED→RESOLVED，重跑非零差额自动打回 OPEN', async () => {
  // 造两个确定性指标：10 与 7，差额恒为 3
  await call('POST', '/api/metric', { metricCode: 'M_A10', name: '常量10', dsCode: 'DS_HIS', probeSql: 'SELECT 10' });
  await call('POST', '/api/metric', { metricCode: 'M_B7', name: '常量7', dsCode: 'DS_HIS', probeSql: 'SELECT 7' });
  const mk = await call('POST', '/api/reconcile', { groupCode: 'SM_TEST', name: '状态机', metricCodes: 'M_A10,M_B7' });
  assert.equal(mk.body.code, 0);

  const run1 = await call('POST', '/api/reconcile/run/SM_TEST', {});
  assert.equal(run1.body.data.diff, 3);
  assert.equal(run1.body.data.disputeStatus, 'OPEN');

  const claim = await call('POST', '/api/reconcile/claim/SM_TEST', {});
  assert.equal(claim.body.code, 0);
  const claimAgain = await call('POST', '/api/reconcile/claim/SM_TEST', {});
  assert.ok(claimAgain.body.msg.includes('认领'), '重复认领被拒: ' + claimAgain.body.msg);

  const noVerdict = await call('POST', '/api/reconcile/resolve/SM_TEST', {});
  assert.ok(noVerdict.body.msg.includes('必填'), '缺 verdict 被拒');

  const resolve = await call('POST', '/api/reconcile/resolve/SM_TEST', { verdict: '以 M_A10 为准', note: '裁决' });
  assert.equal(resolve.body.code, 0);
  const claimAfter = await call('POST', '/api/reconcile/claim/SM_TEST', {});
  assert.ok(claimAfter.body.msg.includes('已裁决'));

  // 重跑出非零差额 → 自动打回 OPEN
  const run2 = await call('POST', '/api/reconcile/run/SM_TEST', {});
  assert.equal(run2.body.data.diff, 3);
  assert.equal(run2.body.data.disputeStatus, 'OPEN', '非零差额打回 OPEN');
  const g = platform.prepare("SELECT * FROM bm_reconcile_group WHERE group_code='SM_TEST'").get();
  assert.equal(g.dispute_status, 'OPEN');
  assert.equal(g.claimed_by, null, '打回时清除认领人');
});

test('RESOLVED 且差额归零：不再打回', async () => {
  await call('POST', '/api/metric', { metricCode: 'M_EQ1', name: '常量1', dsCode: 'DS_HIS', probeSql: 'SELECT 1' });
  await call('POST', '/api/metric', { metricCode: 'M_EQ2', name: '常量1b', dsCode: 'DS_HIS', probeSql: 'SELECT 1' });
  await call('POST', '/api/reconcile', { groupCode: 'EQ_TEST', name: '零差额', metricCodes: 'M_EQ1,M_EQ2' });
  await call('POST', '/api/reconcile/claim/EQ_TEST', {});
  await call('POST', '/api/reconcile/resolve/EQ_TEST', { verdict: '一致' });
  const run = await call('POST', '/api/reconcile/run/EQ_TEST', {});
  assert.equal(run.body.data.diff, 0);
  assert.equal(run.body.data.disputeStatus, 'RESOLVED', '差额为 0 不打回');
});

test('对账组不存在: run/claim/resolve 均报错', async () => {
  for (const p of ['/run/NOPE', '/claim/NOPE', '/resolve/NOPE']) {
    const r = await call('POST', '/api/reconcile' + p, p.includes('resolve') ? { verdict: 'x' } : {});
    assert.ok(r.body.msg.includes('不存在'), p + ': ' + r.body.msg);
  }
});

// lab 沙箱集成测试（PG 隔离；验证 16 表沙箱 + 工具数字契约 + 终态防护）
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

process.env.DATA_DIR = path.resolve('data-test', 'lab');

let LAB_TOOLS, finalizeArmResult, labResetSync, businessDb;

before(async () => {
  const { ensureDatabases, platform } = await import('../src/db.js');
  await ensureDatabases();
  await platform.initSchema(); // labResetSync 要在平台库登记 DS_LAB 数据源
  ({ LAB_TOOLS, finalizeArmResult, labResetSync } = await import('../src/misc.js'));
  ({ businessDb } = await import('../src/db.js'));
  const { seedDemoDbs } = await import('../src/seed/demo.js');
  await seedDemoDbs(true);
  await labResetSync();
});

test('沙箱: 16 张业务表（含 lab_dict_status / status_map）', async () => {
  const db = await businessDb('DS_LAB');
  const t = (await db.prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'").all()).map(r => r.name);
  assert.equal(t.length, 16);
  assert.ok(t.includes('lab_dict_status'));
  assert.ok(t.includes('status_map'));
});

test('fee_gap_scan: 5 笔 / ¥205（数字契约）', async () => {
  const rows = await LAB_TOOLS.fee_gap_scan();
  assert.equal(rows.reduce((s, r) => s + r.fee_cnt, 0), 5);
  assert.equal(Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100), 20500);
});

test('status_gap: 裂缝 C 码（LIS v5.2 已用、HIS 未映射）', async () => {
  const r = await LAB_TOOLS.status_gap();
  assert.ok(r.lisCurrent.some(x => x.status_code === 'C'));
  assert.ok(r.gaps.length >= 1, '至少一个状态码裂缝');
  assert.ok(r.gaps.some(g => g.includes('C')));
});

test('qc_check: 陈芳 ZY20260805006 有过敏冲突', async () => {
  const r = await LAB_TOOLS.qc_check({ inhos_no: 'ZY20260805006' });
  assert.ok(r.findings.some(f => f.includes('过敏')), 'findings: ' + JSON.stringify(r.findings));
});

test('patient_search: 陈芳 → ZY20260805006', async () => {
  const r = await LAB_TOOLS.patient_search({ name: '陈芳' });
  assert.ok(r.matches.length >= 1);
  assert.equal(r.matches[0].inhos_no, 'ZY20260805006');
});

test('finalizeArmResult: 无工具出结论 → NO_EVIDENCE', () => {
  const fin = finalizeArmResult('结论', [{ kind: 'FINAL' }]);
  assert.equal(fin.status, 'NO_EVIDENCE');
  assert.ok(fin.answer.includes('警告'));
});

test('finalizeArmResult: 有工具有结论 → DONE', () => {
  const fin = finalizeArmResult('结论', [{ kind: 'TOOL' }, { kind: 'FINAL' }]);
  assert.equal(fin.status, 'DONE');
});

test('finalizeArmResult: 无结论 → BUDGET_CUT', () => {
  const fin = finalizeArmResult(null, [{ kind: 'TOOL' }]);
  assert.equal(fin.status, 'BUDGET_CUT');
});

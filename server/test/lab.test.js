// lab 沙箱集成测试（隔离 DATA_DIR；验证 16 表沙箱 + 工具数字契约 + 终态防护）
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('data-test', 'lab');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.DATA_DIR = dir;

let LAB_TOOLS, finalizeArmResult, labResetSync, businessDb;

before(async () => {
  ({ LAB_TOOLS, finalizeArmResult, labResetSync } = await import('../src/misc.js'));
  ({ businessDb } = await import('../src/db.js'));
  const { seedDemoDbs } = await import('../src/seed/demo.js');
  seedDemoDbs(true);
  labResetSync();
});

test('沙箱: 16 张业务表（含 lab_dict_status / status_map）', () => {
  const db = businessDb('DS_LAB');
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
  assert.equal(t.length, 16);
  assert.ok(t.includes('lab_dict_status'));
  assert.ok(t.includes('status_map'));
});

test('fee_gap_scan: 5 笔 / ¥205（数字契约）', () => {
  const rows = LAB_TOOLS.fee_gap_scan();
  assert.equal(rows.reduce((s, r) => s + r.fee_cnt, 0), 5);
  assert.equal(Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100), 20500);
});

test('status_gap: 裂缝 C 码（LIS v5.2 已用、HIS 未映射）', () => {
  const r = LAB_TOOLS.status_gap();
  assert.ok(r.lisCurrent.some(x => x.status_code === 'C'));
  assert.ok(r.gaps.length >= 1, '至少一个状态码裂缝');
  assert.ok(r.gaps.some(g => g.includes('C')));
});

test('qc_check: 陈芳 ZY20260805006 有过敏冲突', () => {
  const r = LAB_TOOLS.qc_check({ inhos_no: 'ZY20260805006' });
  assert.ok(r.findings.some(f => f.includes('过敏')), 'findings: ' + JSON.stringify(r.findings));
});

test('patient_search: 陈芳 → ZY20260805006', () => {
  const r = LAB_TOOLS.patient_search({ name: '陈芳' });
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

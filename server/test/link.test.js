// 链路追溯 + 影响分析 + 证据链集成测试（隔离 DATA_DIR；禁用 LLM；BFS/故事线/自动转工单/留痕 spans）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

process.env.LLM_API_KEY = '';
process.env.LLM_BACKUP_API_KEY = '';

const dir = path.resolve('data-test', 'link');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.DATA_DIR = dir;

let app, server, adminToken, platform;

before(async () => {
  ({ platform } = await import('../src/db.js'));
  const { seedDemoDbs } = await import('../src/seed/demo.js');
  const { seedPlatformData } = await import('../src/seed/platform.js');
  const { linkRouter, traceRouter } = await import('../src/link.js');
  const { requireAuth, authorize, issueToken, seedUsers } = await import('../src/auth.js');

  assert.equal(seedDemoDbs(true), true);
  seedPlatformData();
  seedUsers();
  adminToken = issueToken(platform.prepare("SELECT * FROM bm_user WHERE username='admin'").get());

  app = express();
  app.use(express.json());
  app.use(requireAuth);
  app.use(authorize);
  app.use('/api/link', linkRouter);
  app.use('/api/trace', traceRouter);
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

test('种子故事线: LAB_APPLY 链路含 变更/发布，告警挂 LAB_REPORT，工单挂 FEE_DETAIL', async () => {
  const r = await call('GET', '/api/link/chain/LAB_APPLY');
  assert.equal(r.body.data.conceptCode, 'LAB_APPLY');
  const types = new Set(r.body.data.nodes.map(n => n.node_type));
  for (const t of ['CHANGE', 'DEPLOY']) assert.ok(types.has(t), '缺 ' + t);
  const rep = await call('GET', '/api/link/chain/LAB_REPORT');
  assert.ok(rep.body.data.nodes.some(n => n.node_type === 'ALERT'), 'LAB_REPORT 下挂危急值告警');
  const fee = await call('GET', '/api/link/chain/FEE_DETAIL');
  assert.ok(fee.body.data.nodes.some(n => n.node_type === 'TICKET'), 'FEE_DETAIL 下挂治理转办工单');
  const rels = (await call('GET', '/api/link/chain/FEE_DETAIL/rels')).body.data;
  assert.ok(rels.some(e => e.rel_type === 'CAUSES'), '存在 CAUSES 因果边');
});

test('双向 BFS 追溯: 从种子工单追到根因变更', async () => {
  const ch = platform.prepare("SELECT ref_no FROM link_node WHERE node_type='CHANGE' AND concept_code='LAB_APPLY' ORDER BY id LIMIT 1").get();
  const tk = platform.prepare("SELECT ref_no FROM link_node WHERE node_type='TICKET' ORDER BY id LIMIT 1").get();
  const r = await call('GET', `/api/link/trace/${tk.ref_no}`);
  assert.equal(r.body.data.root.ref_no, tk.ref_no);
  assert.ok(r.body.data.nodes.some(n => n.ref_no === ch.ref_no), 'BFS 覆盖根因变更节点');
  assert.ok(r.body.data.edges.length >= 1);
  // 节点不存在
  const miss = await call('GET', '/api/link/trace/NOPE');
  assert.ok(miss.body.msg.includes('节点不存在'));
});

test('建节点 + 挂接关系 + 校验', async () => {
  const ch = platform.prepare("SELECT ref_no FROM link_node WHERE node_type='CHANGE' ORDER BY id LIMIT 1").get().ref_no;
  const bad = await call('POST', '/api/link', { nodeType: 'TICKET', refNo: 'T-TEST-001' });
  assert.ok(bad.body.msg.includes('不能为空'));
  const dup = await call('POST', '/api/link', { nodeType: 'TICKET', refNo: ch, title: 'x', conceptCode: 'LAB_APPLY' });
  assert.ok(dup.body.msg.includes('已存在'));
  const mk = await call('POST', '/api/link', {
    nodeType: 'TICKET', refNo: 'T-TEST-001', title: '测试工单', conceptCode: 'LAB_APPLY',
    linkTarget: ch, relType: 'CAUSES', relDirection: 'up',
  });
  assert.equal(mk.body.data, true);
  const rel = platform.prepare("SELECT * FROM link_rel WHERE from_ref_no='T-TEST-001' AND to_ref_no=?").get(ch);
  assert.equal(rel.rel_type, 'CAUSES', 'relDirection=up → 新节点为因');

  const upd = await call('PUT', '/api/link', { id: platform.prepare("SELECT id FROM link_node WHERE ref_no='T-TEST-001'").get().id, status: '处理中' });
  assert.equal(upd.body.data, true);
  assert.equal(platform.prepare("SELECT status FROM link_node WHERE ref_no='T-TEST-001'").get().status, '处理中');
  const nope = await call('PUT', '/api/link', { id: 999999 });
  assert.ok(nope.body.msg.includes('不存在'));
});

test('建关系: 自环/缺端点/未知节点被拒', async () => {
  const a = platform.prepare('SELECT ref_no FROM link_node LIMIT 1').get().ref_no;
  assert.ok((await call('POST', '/api/link/rel', { fromRefNo: 'A', toRefNo: 'A', relType: 'X' })).body.msg.includes('自环'));
  assert.ok((await call('POST', '/api/link/rel', { fromRefNo: 'A', relType: 'X' })).body.msg.includes('不能为空'));
  assert.ok((await call('POST', '/api/link/rel', { fromRefNo: a, toRefNo: 'GHOST', relType: 'X' })).body.msg.includes('GHOST'));
  const ok1 = await call('POST', '/api/link/rel', { fromRefNo: a, toRefNo: 'T-TEST-001', relType: 'RELATED' });
  assert.equal(ok1.body.data, true);
});

test('节点清单: TICKET 按 待处理→处理中 排序', async () => {
  const r = await call('GET', '/api/link/list?nodeType=TICKET&pageNum=1&pageSize=100');
  assert.ok(r.body.data.total >= 1);
  const sts = r.body.data.list.map(n => n.status);
  const firstDone = sts.indexOf('已闭环');
  const lastOpen = sts.lastIndexOf('待处理');
  assert.ok(firstDone === -1 || lastOpen === -1 || firstDone > lastOpen, '待处理应排在已闭环前');
});

test('自动转工单: 取消未退费按患者建 TICKET，二次幂等，CAUSES 回连根因', async () => {
  const r1 = await call('POST', '/api/link/auto-ticket', {});
  assert.ok(r1.body.data.created >= 1, '至少 1 个患者有裂缝');
  const r2 = await call('POST', '/api/link/auto-ticket', {});
  assert.equal(r2.body.data.created, 0, '幂等');
  // 新工单标题脱敏
  const node = platform.prepare("SELECT * FROM link_node WHERE ref_no LIKE 'T-AUTO-%' ORDER BY id DESC LIMIT 1").get();
  assert.ok(node.title.includes('自动检测'));
  if (node.payload.includes('patient')) {
    const payload = JSON.parse(node.payload);
    if (payload.patient) assert.ok(payload.patient.includes('*'));
  }
  assert.ok(platform.prepare("SELECT 1 FROM link_rel r JOIN link_node c ON c.ref_no=r.from_ref_no WHERE r.to_ref_no=? AND c.node_type='CHANGE' AND r.rel_type='CAUSES'").get(node.ref_no));
});

test('影响分析: 多跳 BFS + 映射/指标/用例盘点（LLM 关闭走模板）', async () => {
  const r = await call('POST', '/api/link/impact/analyze', { conceptCode: 'LAB_APPLY', changeDesc: '检验状态字典 v5.3 变更', depth: 2 });
  const d = r.body.data;
  assert.equal(d.conceptName, '检验申请');
  assert.equal(d.llmUsed, false);
  assert.ok(d.advice.includes('变更涉及'));
  assert.ok(Object.keys(d.affectedTables).includes('DS_LIS'), 'LAB_APPLY 有 LIS 映射');
  assert.ok(d.relatedConcepts.length >= 1);
  assert.ok(d.impactLayers['1'] && d.impactLayers['1'].length >= 1);
  // 深度钳制：depth=1 只有一跳层，无二层
  const shallow = (await call('POST', '/api/link/impact/analyze', { conceptCode: 'LAB_APPLY', depth: 1 })).body.data;
  assert.ok(!shallow.impactLayers['2'], 'depth=1 不产生二层');
  assert.ok(d.advice.includes('无测试用例覆盖'), 'LAB_APPLY 无用例 → 模板必须提示补充');
  // FEE_DETAIL 有种子用例 TC-FEE-0032
  const fee = (await call('POST', '/api/link/impact/analyze', { conceptCode: 'FEE_DETAIL' })).body.data;
  assert.ok(fee.coveredTestcases.length >= 1);
  assert.ok(d.history.some(h => h.node_type === 'CHANGE'));
  const nope = await call('POST', '/api/link/impact/analyze', { conceptCode: 'GHOST' });
  assert.ok(nope.body.msg.includes('概念不存在'));
});

test('证据链 MAPPING: 留痕 spans 与锚点', async () => {
  const m = platform.prepare("SELECT id FROM bm_mapping WHERE status='ACTIVE' ORDER BY id LIMIT 1").get();
  const r = await call('GET', `/api/trace?type=MAPPING&key=${m.id}`);
  assert.ok(r.body.data.summary.includes('→'));
  assert.ok(r.body.data.anchors.some(a => a.route.includes('/ontology')));
  const bad = await call('GET', '/api/trace?type=MAPPING&key=abc');
  assert.ok(bad.body.msg.includes('数字'));
});

test('证据链 CONCEPT: 全生命周期 spans 含缺口回流提示字段', async () => {
  const r = await call('GET', '/api/trace?type=CONCEPT&key=LAB_APPLY');
  const titles = r.body.data.spans.map(s => s.title);
  assert.ok(titles.includes('创建概念'));
  assert.ok(titles.includes('属性层'));
  assert.ok(titles.includes('生效映射'));
  assert.ok(titles.includes('状态机'));
  const nope = await call('GET', '/api/trace?type=CONCEPT&key=GHOST');
  assert.ok(nope.body.msg.includes('概念不存在'));
});

test('证据链: 参数缺失/未知类型/QA 不存在', async () => {
  assert.ok((await call('GET', '/api/trace?type=QA')).body.msg.includes('必填'));
  assert.ok((await call('GET', '/api/trace?type=XX&key=1')).body.msg.includes('未知证据链类型'));
  assert.ok((await call('GET', '/api/trace?type=QA&key=nope')).body.msg.includes('不存在'));
});

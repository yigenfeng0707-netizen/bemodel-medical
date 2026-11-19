// 医嘱闭环 + 临床质控集成测试（隔离 DATA_DIR；禁用 LLM 走降级模板；闭环状态机/QC 规则/SHACL/RDF）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import express from 'express';

// 测试期禁用 LLM（.env 有真 key，但测试不外呼；置空在 dotenv 加载前生效）
process.env.LLM_API_KEY = '';
process.env.LLM_BACKUP_API_KEY = '';

const dir = path.resolve('data-test', 'flow');
process.env.DATA_DIR = dir;

let app, server, adminToken, platform, ensureDatabases;

before(async () => {
  ({ platform, ensureDatabases } = await import('../src/db.js'));
  const { seedDemoDbs } = await import('../src/seed/demo.js');
  const { seedPlatformData } = await import('../src/seed/platform.js');
  const { flowRouter, clinicalRouter, exportPatientTurtle } = await import('../src/flow.js');
  const { requireAuth, authorize, issueToken, seedUsers } = await import('../src/auth.js');
  globalThis.__exportTtl = exportPatientTurtle;

  await ensureDatabases();
  await platform.initSchema();

  assert.equal(await seedDemoDbs(true), true);
  await seedPlatformData(true);
  await seedUsers();
  const admin = await platform.prepare("SELECT * FROM bm_user WHERE username='admin'").get();
  adminToken = issueToken(admin);

  app = express();
  app.use(express.json());
  app.use(requireAuth);
  app.use(authorize);
  app.use('/api/flow', flowRouter);
  app.use('/api', clinicalRouter); // /qc/* /alert/* /rdf/*
  app.use((err, req, res, next) => { if (err) res.status(200).json({ code: 500, msg: err.message, data: null }); });

  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.on('listening', r));
});

after(() => server?.close());

async function call(method, url, body, token) {
  const port = server.address().port;
  const r = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, ct, body: ct.includes('json') ? await r.json() : await r.text() };
}

const his = () => import('../src/db.js').then(m => m.businessDb('DS_HIS'));

test('未登录访问闭环接口 401', async () => {
  const r = await call('GET', '/api/flow/patients');
  assert.equal(r.status, 401);
});

test('患者列表: 姓名脱敏 + 医嘱/费用汇总', async () => {
  const r = await call('GET', '/api/flow/patients?pageNum=1&pageSize=50', undefined, adminToken);
  assert.ok(r.body.data.total >= 1);
  assert.ok(r.body.data.list.length >= 1);
  for (const p of r.body.data.list) {
    assert.ok(p.patient_name.includes('*'), '姓名已脱敏: ' + p.patient_name);
    assert.ok(p.orderCount >= 0 && p.feeTotal >= 0);
  }
});

test('住院闭环: 时间线完整 + 状态机四态', async () => {
  // 找一笔「取消未退费」裂缝患者验证 BROKEN
  const db = await his();
  const broken = await db.prepare("SELECT o.inhos_no, o.order_id FROM medical_order o JOIN fee_detail f ON f.order_id=o.order_id WHERE o.order_status='2' AND f.fee_status='1' LIMIT 1").get();
  const r = await call('GET', `/api/flow/loop/${broken.inhos_no}`, undefined, adminToken);
  assert.equal(r.body.code, 0);
  const data = r.body.data;
  assert.ok(data.patient.patient_name.includes('*'));
  const statuses = new Set(data.orders.map(o => o.loopStatus));
  for (const s of statuses) assert.ok(['CLOSED', 'CLOSED_CANCELED', 'BROKEN', 'PENDING'].includes(s), '合法状态: ' + s);
  const target = data.orders.find(o => o.orderId === broken.order_id);
  assert.equal(target.loopStatus, 'BROKEN', '取消未退费 → BROKEN');
  // 时间线：入院 + 开立医嘱 + 计费 至少齐备
  const names = data.timeline.map(e => e.name);
  assert.ok(names.some(n => n === '入院登记'));
  assert.ok(names.some(n => n.startsWith('开立医嘱')));
  assert.ok(names.some(n => n.startsWith('计费')));
  // 排序单调
  const times = data.timeline.map(e => String(e.at));
  assert.deepEqual(times, [...times].sort());
});

test('住院闭环: 住院号不存在报业务错', async () => {
  const r = await call('GET', '/api/flow/loop/NOPE123', undefined, adminToken);
  assert.equal(r.body.code, 500);
  assert.ok(r.body.msg.includes('住院号不存在'));
});

test('门诊同构: 列表 + 闭环', async () => {
  const list = await call('GET', '/api/flow/opd/patients', undefined, adminToken);
  assert.ok(Array.isArray(list.body.data) && list.body.data.length >= 1);
  for (const p of list.body.data) assert.ok(p.pat_name.includes('*'));
  const card = list.body.data[0].pat_card_no;
  const loop = await call('GET', `/api/flow/opd/loop/${card}`, undefined, adminToken);
  assert.equal(loop.body.code, 0);
  const st = new Set(loop.body.data.prescs.map(p => p.loopStatus));
  for (const s of st) assert.ok(['CLOSED', 'CLOSED_CANCELED', 'PENDING', 'UNPAID'].includes(s));
  assert.ok(loop.body.data.timeline.length >= 1);
});

test('人员下钻: 药师足迹跨库统计', async () => {
  const { businessDb } = await import('../src/db.js');
  const phDb = await businessDb('DS_PHARMACY');
  const ph = await phDb.prepare('SELECT pharmacist FROM dispense_record WHERE pharmacist IS NOT NULL LIMIT 1').get();
  const r = await call('GET', `/api/flow/staff?name=${encodeURIComponent(ph.pharmacist)}`, undefined, adminToken);
  assert.equal(r.body.data.found, true);
  assert.ok(r.body.data.footprint['调剂发药'] >= '1');
  assert.ok(Array.isArray(r.body.data.colleagues));
});

test('病案质控 check-all: 预埋矛盾全部命中', async () => {
  const { businessDb } = await import('../src/db.js');
  const emr = await businessDb('DS_EMR');
  const total = (await emr.prepare('SELECT COUNT(*) c FROM emr_record').get()).c;
  const r = await call('POST', '/api/qc/check-all', {}, adminToken);
  assert.equal(r.body.data.total, total);
  assert.equal(r.body.data.fail, 3, '种子实际命中 3 条矛盾（CRP/性别/凝血）');
  // 逐条核对预埋矛盾（MR+idx 补零；idx1→MR0002 等）
  const expect = [
    ['MR0002', 'RULE-QC-003'], // 李红梅：CRP 异常未处置
    ['MR0003', 'RULE-QC-005'], // 王强：男性卵巢囊肿 AX-003
    ['MR0005', 'RULE-QC-002'], // 刘伟：手术术前缺凝血四项
  ];
  for (const [rid, rule] of expect) {
    const row = await platform.prepare('SELECT * FROM qc_result WHERE record_id=? ORDER BY id DESC LIMIT 1').get(rid);
    assert.ok(row, '质控结果落表 ' + rid);
    assert.equal(row.pass_flag, 0);
    const findings = JSON.parse(row.findings_json);
    assert.ok(findings.some(f => f.ruleCode === rule), `${rid} 应命中 ${rule}，实际: ${findings.map(f => f.ruleCode).join(',')}`);
  }
  // 王强的 AX-003 溯源
  const ax = JSON.parse((await platform.prepare("SELECT findings_json FROM qc_result WHERE record_id='MR0003' ORDER BY id DESC LIMIT 1").get()).findings_json)
    .find(f => f.ruleCode === 'RULE-QC-005');
  assert.equal(ax.axiom, 'AX-003');
  assert.equal((await emr.prepare("SELECT qc_status FROM emr_record WHERE record_id='MR0003'").get()).qc_status, '不通过');
  // 其余病案通过
  assert.ok((await platform.prepare('SELECT COUNT(*) c FROM qc_result WHERE pass_flag=1').get()).c >= 20);
});

test('单病案质控 check: 结论 + 模板摘要（LLM 关闭不外呼）', async () => {
  const r = await call('POST', '/api/qc/check/MR0003', {}, adminToken);
  assert.equal(r.body.data.pass, false);
  assert.equal(r.body.data.llmUsed, false);
  assert.ok(r.body.data.llmSummary.includes('质控发现'));
  assert.ok(r.body.data.trace.ontologyVersion !== undefined);
});

test('危急值预警: 首扫创建、二扫幂等', async () => {
  const r1 = await call('POST', '/api/alert/detect', {}, adminToken);
  assert.ok(r1.body.data.abnormalReports >= 1);
  assert.ok(r1.body.data.created >= 1, '至少创建一条危急值 ALERT');
  const r2 = await call('POST', '/api/alert/detect', {}, adminToken);
  assert.equal(r2.body.data.created, 0, '第二次扫描幂等不重复建');
  const node = await platform.prepare("SELECT * FROM link_node WHERE node_type='ALERT' AND ref_no LIKE 'ALERT-LR%'").get();
  assert.ok(node);
  assert.equal(node.payload.includes('*') || node.payload.includes('inhos_no'), true, '载荷含脱敏患者或住院号');
});

test('RDF ABox 导出: Turtle 结构 + 无明文姓名 + 过敏原', async () => {
  const ttl = await globalThis.__exportTtl('ZY20260805006', true);
  assert.ok(ttl.includes('@prefix med: <http://bemodel.com/ontology/med#>'));
  assert.ok(ttl.includes('med:Patient_ZY20260805006 a med:Patient'));
  assert.ok(ttl.includes('med:hasAllergyTo'));
  assert.ok(!ttl.includes('陈芳'), '导出不含明文姓名');
  assert.ok(ttl.includes('a med:DrugOrder') || ttl.includes('a med:LabOrder'));
  // 未脱敏参数也不含姓名（导出模板本就无姓名字段）
  const raw = await globalThis.__exportTtl('ZY20260805006', false);
  assert.ok(!raw.includes('陈芳'));
});

test('RDF 导出 HTTP: Content-Type text/turtle', async () => {
  const r = await call('GET', '/api/rdf/patient/ZY20260805006', undefined, adminToken);
  assert.ok(r.ct.includes('text/turtle'));
  assert.ok(String(r.body).includes('med:Patient_ZY20260805006'));
});

test('SHACL: 头孢过敏 GATE 病例命中 AllergyConstraint', async () => {
  const r = await call('POST', '/api/rdf/validate/ZY20260805006', {}, adminToken);
  assert.equal(r.body.data.conforms, false);
  assert.ok(r.body.data.violations.some(v => v.message.includes('AllergyConstraint') && v.message.includes('头孢')), JSON.stringify(r.body.data.violations));
  assert.equal(r.body.data.shapes, '6 Shapes');
});

test('SHACL: 男性卵巢囊肿命中 SexDisjointDiag（AX-003）', async () => {
  const db = await his();
  const p = await db.prepare("SELECT inhos_no FROM inpatient WHERE patient_name='王强'").get();
  const r = await call('POST', `/api/rdf/validate/${p.inhos_no}`, {}, adminToken);
  assert.ok(r.body.data.violations.some(v => v.message.includes('SexDisjointDiagShape') && v.message.includes('N83')), JSON.stringify(r.body.data.violations));
});

test('SHACL: 儿童禁用药命中 ChildForbidden', async () => {
  const db = await his();
  const p = await db.prepare("SELECT inhos_no FROM inpatient WHERE patient_name='韩小梅'").get();
  const r = await call('POST', `/api/rdf/validate/${p.inhos_no}`, {}, adminToken);
  assert.ok(r.body.data.violations.some(v => v.message.includes('ChildForbiddenShape')), JSON.stringify(r.body.data.violations));
});

test('SHACL: 患者不存在返回单条 Violation', async () => {
  const r = await call('POST', '/api/rdf/validate/NOPE123', {}, adminToken);
  assert.equal(r.body.data.conforms, false);
  assert.equal(r.body.data.violations.length, 1);
  assert.equal(r.body.data.violations[0].message, '患者不存在');
});

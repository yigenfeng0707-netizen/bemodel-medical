// 智能客服 + 语义问数集成测试（禁 LLM 走规则降级；六档核对/口径卡/澄清/反馈回路/工单处置）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

process.env.LLM_API_KEY = '';
process.env.LLM_BACKUP_API_KEY = '';
process.env.EMBEDDING_TIMEOUT_MS = '1';

const dir = path.resolve('data-test', 'cs');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.DATA_DIR = dir;

let app, server, adminToken, platform, businessDb;

before(async () => {
  ({ platform, businessDb } = await import('../src/db.js'));
  const { seedDemoDbs } = await import('../src/seed/demo.js');
  const { seedPlatformData } = await import('../src/seed/platform.js');
  const { csRouter } = await import('../src/cs.js');
  const { requireAuth, authorize, issueToken, seedUsers } = await import('../src/auth.js');

  assert.equal(seedDemoDbs(true), true);
  seedPlatformData();
  seedUsers();
  adminToken = issueToken(platform.prepare("SELECT * FROM bm_user WHERE username='admin'").get());

  app = express();
  app.use(express.json());
  app.use(requireAuth);
  app.use(authorize);
  app.use('/api/cs', csRouter);
  app.use((err, req, res, next) => { if (err) res.status(200).json({ code: 500, msg: err.message, data: null }); });

  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.on('listening', r));
});

after(() => server?.close());

async function call(method, url, body, token) {
  const port = server.address().port;
  const r = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: 'Bearer ' + (token || adminToken) }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
async function ask(q, scene) {
  const r = await call('POST', '/api/cs/ask', { question: q, ...(scene ? { scene } : {}) });
  assert.equal(r.body.code, 0, r.body.msg);
  return r.body.data;
}

test('六档跨库核对: 结构不变量 + 落库 bm_recon_diff + 异常计数排除在途/凌晨', async () => {
  const { reconcileDispensePay } = await import('../src/cs.js');
  const r = reconcileDispensePay();
  assert.ok(r.runId.startsWith('RECON-'));
  assert.equal(r.tiers.length, 6);
  assert.deepEqual(r.tiers.map(t => t.stateCode),
    ['VIOLATION_PREPAY_BYPASS', 'RETURNED_PENDING_REFUND', 'STUCK_BACKLOG', 'IN_FLIGHT', 'CANCELLED_AFTER_PAY', 'NIGHTLY_CANCEL']);
  const sum = r.tiers.reduce((s, t) => s + t.count, 0);
  assert.equal(r.registered, sum);
  assert.equal(r.diffs.length, sum);
  const skip = r.tiers.filter(t => ['IN_FLIGHT', 'NIGHTLY_CANCEL'].includes(t.stateCode)).reduce((s, t) => s + t.count, 0);
  assert.equal(r.abnormalCount, sum - skip);
  // 每档 severity / 归因 / 建议动作齐全
  for (const t of r.tiers) {
    assert.ok(['VIOLATION', 'WATCH', 'NORMAL'].includes(t.severity));
    assert.ok(t.attribution.length > 4);
    assert.ok(t.suggestedAction.length > 4);
  }
  const rows = platform.prepare('SELECT * FROM bm_recon_diff WHERE run_id=?').all(r.runId);
  assert.equal(rows.length, r.diffs.length);
});

test('FEE 直答: 5 名患者 / 5 笔 / ¥205 契约数字 + 根因条目', async () => {
  const a = await ask('检验取消了怎么还收费，患者投诉');
  assert.equal(a.intent, 'FEE');
  assert.ok(a.answer.includes('5 名患者'));
  assert.ok(a.answer.includes('5 笔'));
  assert.ok(a.answer.includes('¥205'));
  assert.ok(a.answer.includes('根因'));
  assert.ok(a.evidence.some(e => e[1] === 'CS_RULE_FEE_ROOT'));
});

test('DISPENSE_PAY: 实时核对执行（演示数据全配平 → 无差异）', async () => {
  const a = await ask('先药后费是怎么回事');
  assert.equal(a.intent, 'DISPENSE_PAY');
  assert.ok(a.reconRunId);
  assert.ok(a.answer.includes('三库实时核对'));
  assert.ok(a.answer.includes('0 笔异常差异'));
  assert.ok(a.answer.includes('无差异'));
});

test('recon/diffs: 按 runId 过滤 + 默认最新批次', async () => {
  // 演示数据六档配平，合成一行差异验证端点
  const runId = 'RECON-TEST-0001';
  platform.prepare(`INSERT INTO bm_recon_diff(run_id,direction,state_code,severity,attribution,suggested_action,patient_no,order_id,item_name)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(runId, 'A', 'VIOLATION_PREPAY_BYPASS', 'VIOLATION', '先药后费', '追缴', 'ZY20260815001', 'MO-X', '测试项');
  const byRun = await call('GET', `/api/cs/recon/diffs?runId=${runId}`);
  assert.equal(byRun.body.data.length, 1);
  assert.equal(byRun.body.data[0].state_code, 'VIOLATION_PREPAY_BYPASS');
  const latest = await call('GET', '/api/cs/recon/diffs');
  assert.equal(latest.body.data.length, 1);
  assert.equal(latest.body.data[0].run_id, runId);
  platform.prepare('DELETE FROM bm_recon_diff WHERE run_id=?').run(runId);
});

test('GLOSSARY 口径卡: 指标名命中 → CANCEL_NOT_REFUND 实测 5', async () => {
  const a = await ask('取消未退费笔数的口径是什么');
  assert.equal(a.intent, 'GLOSSARY');
  assert.ok(a.answer.includes('【口径卡】'));
  assert.equal(a.metric.metricCode, 'CANCEL_NOT_REFUND');
  assert.equal(a.metric.lastVal, 5, '探针实测 5 笔');
  assert.equal(a.metric.warnThreshold, 0);
  assert.equal(a.metric.reconciled, null, '未进对账组');
});

test('问数场景: 指标名直命中出卡（router=RULE）', async () => {
  const a = await ask('取消未退费笔数', 'ANALYTICS');
  assert.equal(a.router, 'RULE');
  assert.equal(a.metric.metricCode, 'CANCEL_NOT_REFUND');
  assert.ok(a.traceId);
  const trace = platform.prepare('SELECT * FROM bm_qa_trace WHERE trace_id=?').get(a.traceId);
  assert.ok(trace, 'QA 轨迹已落库');
});

test('问数场景: LLM 不可用规则兜底口径卡（ruleFallback 诚实标注）', async () => {
  const a = await ask('取消未退费笔数有多少', 'ANALYTICS');
  assert.equal(a.router, 'RULE');
  assert.equal(a.ruleFallback, true);
  assert.equal(a.metric.metricCode, 'CANCEL_NOT_REFUND');
});

test('问数场景: 词表外问题 → 能力菜单（parseEmpty，不记 miss）', async () => {
  const beforeMiss = platform.prepare("SELECT COUNT(*) c FROM bm_ontology_miss WHERE source='QA_ASK'").get().c;
  const a = await ask('今天天气怎么样', 'ANALYTICS');
  assert.equal(a.router, 'REFERRAL');
  assert.equal(a.parseEmpty, true);
  assert.ok(a.answer.includes('语义层已发布概念'));
  assert.equal(platform.prepare("SELECT COUNT(*) c FROM bm_ontology_miss WHERE source='QA_ASK'").get().c, beforeMiss);
});

test('能力菜单: 兜不住的问题转智能问数并给入口链接', async () => {
  const a = await ask('今天食堂吃什么');
  assert.equal(a.router, 'REFERRAL');
  assert.ok(a.answer.includes('我能做'));
  assert.ok(a.links.some(l => l.route.startsWith('/ask?q=')));
});

test('STAFF: 人员主数据命中与未命中两分支', async () => {
  const s = businessDb('DS_HIS').prepare("SELECT staff_name FROM staff WHERE staff_name LIKE '%张%' LIMIT 1").get()
    || businessDb('DS_HIS').prepare('SELECT staff_name FROM staff LIMIT 1').get();
  assert.ok(s, '种子有人员数据');
  const name = s.staff_name;
  // staffAnswer 取问句首个 2-3 字汉字段的末两字做 LIKE，需用空格分隔姓名
  const hit = await ask(`${name} 是哪个科室的医生`);
  assert.equal(hit.intent, 'STAFF');
  assert.ok(hit.answer.includes(name), `应命中 ${name}，实际：${hit.answer}`);
  const miss = await ask('花木兰 是哪个科室的医生');
  assert.equal(miss.intent, 'STAFF');
  assert.ok(miss.answer.includes('未在人员主数据中找到'));
});

test('MATERIAL / DISPENSE_RETURN / DISPENSE_SPLIT: 库存与退药问答', async () => {
  const mat = await ask('库存里哪些耗材需要申领');
  assert.equal(mat.intent, 'MATERIAL');
  assert.ok(mat.answer.includes('低库存'));
  const ret = await ask('退药了但钱没到账');
  assert.equal(ret.intent, 'DISPENSE_RETURN');
  assert.ok(ret.answer.includes('已退药记录'));
  const split = await ask('存在分次发药的情况吗');
  assert.equal(split.intent, 'DISPENSE_SPLIT');
  assert.ok(split.answer.includes('分次发药'));
});

test('DOC_QA: 知识库制度问答（LLM 关闭走模板引用）', async () => {
  const a = await ask('lis 系统升级通告说了什么');
  assert.equal(a.intent, 'DOC_QA');
  assert.ok(a.answer.startsWith('依据《'), a.answer);
  assert.ok(a.evidence.length >= 1);
  assert.ok(a.evidence[0][0].includes('《'));
});

test('澄清任务: 校验规则 + 两轮内补充解决 → RESOLVED', async () => {
  // 不存在
  const e1 = await call('POST', '/api/cs/clarify/99999/answer', { supplement: 'x' });
  assert.ok(e1.body.msg.includes('不存在'));
  // 建一个 PENDING 任务（LLM 关闭时 AMBIGUITY 分支不可达，直接造）
  const ins = platform.prepare(`INSERT INTO bm_clarify_task(scene,origin_question,reason,gap_type,clarify_question,status,rounds)
    VALUES ('CS','这个描述不清的问题xyz','','AMBIGUITY','请补充时间范围/科室/对象','PENDING',1)`).run();
  const id = Number(ins.lastInsertRowid);
  // 空补充
  const e2 = await call('POST', `/api/cs/clarify/${id}/answer`, { supplement: '  ' });
  assert.ok(e2.body.msg.includes('不能为空'));
  // 重复补充
  platform.prepare("UPDATE bm_clarify_task SET supplement='甲' WHERE id=?").run(id);
  const e3 = await call('POST', `/api/cs/clarify/${id}/answer`, { supplement: '甲' });
  assert.ok(e3.body.msg.includes('重复'));
  // 超长
  const e4 = await call('POST', `/api/cs/clarify/${id}/answer`, { supplement: '超'.repeat(1100) });
  assert.ok(e4.body.msg.includes('1024'));
  // 已关闭
  platform.prepare("UPDATE bm_clarify_task SET status='RESOLVED' WHERE id=?").run(id);
  const e5 = await call('POST', `/api/cs/clarify/${id}/answer`, { supplement: 'x' });
  assert.ok(e5.body.msg.includes('已关闭'));
  // 成功路径：重入后规则兜不住 → 能力菜单（无 clarify/unanswered）→ RESOLVED
  platform.prepare("UPDATE bm_clarify_task SET status='PENDING', supplement='', rounds=1 WHERE id=?").run(id);
  const ok1 = await call('POST', `/api/cs/clarify/${id}/answer`, { supplement: '随便补充一点' });
  assert.equal(ok1.body.code, 0);
  assert.equal(ok1.body.data.clarifyResolved, true);
  const task = platform.prepare('SELECT * FROM bm_clarify_task WHERE id=?').get(id);
  assert.equal(task.status, 'RESOLVED');
  assert.ok(task.answered_at);
  // 列表按 PENDING 优先
  const list = await call('GET', '/api/cs/clarify/list');
  assert.ok(Array.isArray(list.body.data));
});

test('评议回路: 提交纠错反馈 + 分页查询（且 routeAsk 读反馈不报错）', async () => {
  const r = await call('POST', '/api/cs/feedback', { question: '检验取消了怎么收费', intent: 'FEE', router: 'RULE', correct: false, comment: '应关注退费时效' });
  assert.equal(r.body.data, true);
  const list = await call('GET', '/api/cs/feedback/list?pageNum=1&pageSize=10');
  assert.ok(list.body.data.total >= 1);
  assert.ok(list.body.data.list.some(f => f.comment === '应关注退费时效'));
  // 反馈入库后 ask 仍正常（feedbackText 注入 LLM 提示词路径）
  const a = await ask('取消未退费笔数的口径');
  assert.equal(a.intent, 'GLOSSARY');
});

test('工单诊断: runRca 七步证据链 + LLM 关闭时 llmUsed=false', async () => {
  const t = platform.prepare("SELECT id FROM link_node WHERE ref_no='T-20260901-001'").get();
  assert.ok(t);
  const r = await call('GET', `/api/cs/ticket/${t.id}/diagnosis`);
  assert.equal(r.body.code, 0, r.body.msg);
  const d = r.body.data;
  assert.ok(d.caseId);
  assert.equal(d.steps.length, 7);
  assert.equal(d.llmUsed, false);
  assert.ok(d.conclusion.includes('LIS v5.2'));
  assert.ok(d.conclusion.includes('全院共影响5名患者、5笔费用'), d.conclusion);
  assert.equal(d.evidence.length, 6);
  assert.equal(d.suggestions.length, 4);
  const c = platform.prepare('SELECT * FROM rca_case WHERE id=?').get(d.caseId);
  assert.equal(c.status, 'DONE');
  const rep = platform.prepare('SELECT * FROM rca_report WHERE case_id=?').get(d.caseId);
  assert.equal(rep.llm_used, 0);
  // 步骤 2：患者账单核查命中数与 HIS 实查一致
  const billCnt = businessDb('DS_HIS').prepare(`SELECT COUNT(*) c FROM fee_detail f JOIN medical_order o ON f.order_id=o.order_id
    WHERE o.order_status='2' AND f.fee_status='1' AND f.inhos_no='ZY20260815001'`).get().c;
  const step2 = d.steps.find(s => s.stepNo === 2);
  assert.equal(step2.hitCount, billCnt);
  // 步骤 7 报告
  const step7 = d.steps.find(s => s.stepNo === 7);
  assert.equal(step7.stepType, 'REPORT');
});

test('一键退费: 生成退费申请 + 处置单 + 工单办结，二次调用幂等复用', async () => {
  // 动态找一个 payload 含住院号且该患者确有「取消未退费」费用的工单
  const tickets = platform.prepare("SELECT id, ref_no, payload FROM link_node WHERE node_type='TICKET' ORDER BY id").all();
  let target = null;
  for (const t of tickets) {
    let p = {}; try { p = JSON.parse(t.payload || '{}'); } catch { /* */ }
    if (!p.inhos_no) continue;
    const n = businessDb('DS_HIS').prepare(`SELECT COUNT(*) c FROM fee_detail f JOIN medical_order o ON f.order_id=o.order_id
      WHERE o.order_status='2' AND f.fee_status='1' AND f.inhos_no=?`).get(p.inhos_no).c;
    if (n > 0) { target = { ...t, inhos: p.inhos_no }; break; }
  }
  assert.ok(target, '种子中应存在有裂缝费用的工单');
  const t = target;
  const expected = businessDb('DS_HIS').prepare(`SELECT f.fee_id, f.amount FROM fee_detail f JOIN medical_order o ON f.order_id=o.order_id
    WHERE o.order_status='2' AND f.fee_status='1' AND f.inhos_no=?`).all(t.inhos);
  assert.ok(expected.length >= 1);
  const r1 = await call('POST', `/api/cs/ticket/${t.id}/refund?operator=测试员`, {});
  assert.equal(r1.body.code, 0, JSON.stringify(r1.body));
  assert.equal(r1.body.data.refundCount, expected.length);
  assert.equal(r1.body.data.totalAmount, expected.reduce((s, x) => s + x.amount, 0));
  assert.equal(r1.body.data.refunds.filter(x => x.reused).length, 0);
  for (const x of r1.body.data.refunds) {
    const ra = businessDb('DS_CHARGE').prepare('SELECT * FROM refund_apply WHERE refund_id=?').get(x.refundId);
    assert.ok(ra, '退费申请已落库');
    assert.equal(ra.status, '1');
  }
  // 处置单 + CLOSED_BY 边 + 工单状态
  const dis = platform.prepare("SELECT * FROM link_node WHERE node_type='DISPOSAL' AND ref_no=?").get(r1.body.data.disposalRef);
  assert.ok(dis);
  assert.equal(dis.status, '已办结');
  const rel = platform.prepare("SELECT * FROM link_rel WHERE from_ref_no=? AND rel_type='CLOSED_BY'").get(t.ref_no);
  assert.ok(rel);
  assert.equal(platform.prepare('SELECT status s FROM link_node WHERE id=?').get(t.id).s, '已处置');
  // 幂等：二次调用全部复用
  const r2 = await call('POST', `/api/cs/ticket/${t.id}/refund`, {});
  assert.equal(r2.body.code, 0, JSON.stringify(r2.body));
  assert.equal(r2.body.data.refundCount, expected.length);
  assert.equal(r2.body.data.refunds.filter(x => x.reused).length, expected.length);
});

test('一键退费: 工单缺住院号报错', async () => {
  const ins = platform.prepare(`INSERT INTO link_node(node_type,ref_no,title,concept_code,status,occurred_at,payload)
    VALUES ('TICKET','T-TEST-NOINHOS','缺住院号工单','FEE_DETAIL','待处理',datetime('now','localtime'),'{}')`).run();
  const id = ins.lastInsertRowid;
  const r = await call('POST', `/api/cs/ticket/${id}/refund`, {});
  assert.ok(r.body.msg.includes('缺少住院号'));
});

test('客户回复: 模板致歉 + 根因结论 + 整改依据（llmUsed=false）', async () => {
  const t = platform.prepare("SELECT id FROM link_node WHERE ref_no='T-20260901-001'").get();
  const r = await call('GET', `/api/cs/ticket/customer-reply/${t.id}`);
  assert.equal(r.body.code, 0);
  const d = r.body.data;
  assert.equal(d.llmUsed, false);
  assert.ok(d.reply.includes('您好，经排查'));
  assert.ok(d.reply.includes('LIS v5.2'));
  assert.ok(Array.isArray(d.basis));
});

test('权限: 未登录写接口 401（refund 不在 openPosts）', async () => {
  const r = await call('POST', '/api/cs/ticket/1/refund', {}, null);
  assert.equal(r.status, 401);
});

test('入参校验: 空问题报错', async () => {
  const r = await call('POST', '/api/cs/ask', { question: '  ' });
  assert.ok(r.body.msg.includes('不能为空'));
});

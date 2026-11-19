import express from 'express';
import { platform, now, businessDb } from './db.js';
import { BizException, ok, maskName } from './common.js';
import { chat } from './llm.js';

export const linkRouter = express.Router();
const L = linkRouter;

// ---------- 链路节点 ----------
L.get('/list', async (req, res) => {
  const { nodeType, conceptCode, pageNum = 1, pageSize = 20 } = req.query;
  let sql = 'SELECT * FROM link_node WHERE 1=1';
  const params = [];
  if (nodeType) { sql += ' AND node_type=?'; params.push(nodeType); }
  if (conceptCode) { sql += ' AND concept_code=?'; params.push(conceptCode); }
  const total = (await platform.prepare(`SELECT COUNT(*) c FROM (${sql})`).get(...params)).c;
  const order = nodeType === 'TICKET' ? " ORDER BY CASE status WHEN '待处理' THEN 0 WHEN '处理中' THEN 1 ELSE 2 END, id DESC" : ' ORDER BY occurred_at DESC, id DESC';
  const list = await platform.prepare(sql + order + ' LIMIT ? OFFSET ?').all(...params, Number(pageSize), (Number(pageNum) - 1) * Number(pageSize));
  res.json(ok({ list, total, pageNum: Number(pageNum), pageSize: Number(pageSize) }));
});
L.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.nodeType || !b.refNo || !b.title || !b.conceptCode) throw new BizException('类型/单号/标题/概念不能为空');
  if (await platform.prepare('SELECT 1 FROM link_node WHERE ref_no=?').get(b.refNo)) throw new BizException('单号已存在');
  await platform.prepare('INSERT INTO link_node(node_type,ref_no,title,concept_code,status,occurred_at,payload) VALUES (?,?,?,?,?,?,?)')
    .run(b.nodeType, b.refNo, b.title, b.conceptCode, b.status || '待处理', b.occurredAt || now(), b.payload || '{}');
  if (b.linkTarget && b.relType) {
    const [from, to] = b.relDirection === 'up' ? [b.refNo, b.linkTarget] : [b.linkTarget, b.refNo];
    await platform.prepare('INSERT INTO link_rel(from_ref_no,to_ref_no,rel_type,remark) VALUES (?,?,?,?) ON CONFLICT DO NOTHING').run(from, to, b.relType, '建节点挂接');
  }
  res.json(ok(true));
});
L.put('/', async (req, res) => {
  const n = await platform.prepare('SELECT * FROM link_node WHERE id=?').get(req.body?.id);
  if (!n) throw new BizException('节点不存在');
  await platform.prepare('UPDATE link_node SET title=?, status=?, payload=?, occurred_at=? WHERE id=?')
    .run(req.body.title ?? n.title, req.body.status ?? n.status, req.body.payload ?? n.payload, req.body.occurredAt ?? n.occurred_at, n.id);
  res.json(ok(true));
});
// 概念链路视图（故事线）
L.get('/chain/:conceptCode', async (req, res) => {
  const nodes = await platform.prepare('SELECT * FROM link_node WHERE concept_code=? ORDER BY occurred_at, id').all(req.params.conceptCode);
  const groups = {};
  for (const n of nodes) (groups[n.node_type] = groups[n.node_type] || []).push(n);
  res.json(ok({ conceptCode: req.params.conceptCode, nodes, groups }));
});
L.get('/chain/:conceptCode/rels', async (req, res) => {
  const refs = (await platform.prepare('SELECT ref_no FROM link_node WHERE concept_code=?').all(req.params.conceptCode)).map(r => r.ref_no);
  if (!refs.length) return res.json(ok([]));
  const ph = refs.map(() => '?').join(',');
  res.json(ok(await platform.prepare(`SELECT * FROM link_rel WHERE from_ref_no IN (${ph}) OR to_ref_no IN (${ph}) ORDER BY id`).all(...refs, ...refs)));
});
// 双向 BFS 追溯
L.get('/trace/:refNo', async (req, res) => {
  const root = await platform.prepare('SELECT * FROM link_node WHERE ref_no=?').get(req.params.refNo);
  if (!root) throw new BizException('节点不存在');
  const MAX_DEPTH = 6;
  const visited = new Set([root.ref_no]);
  const edges = [];
  const seenEdges = new Set();
  let frontier = [root.ref_no];
  for (let d = 0; d < MAX_DEPTH && frontier.length; d++) {
    const next = [];
    for (const cur of frontier) {
      for (const rel of await platform.prepare('SELECT * FROM link_rel WHERE from_ref_no=? OR to_ref_no=?').all(cur, cur)) {
        if (!seenEdges.has(rel.id)) { seenEdges.add(rel.id); edges.push(rel); }
        const nxt = rel.from_ref_no === cur ? rel.to_ref_no : rel.from_ref_no;
        if (!visited.has(nxt)) { visited.add(nxt); next.push(nxt); }
      }
    }
    frontier = next;
  }
  const nodes = [root, ...(await platform.prepare(`SELECT * FROM link_node WHERE ref_no IN (${[...visited].map(() => '?').join(',')}) AND ref_no<>?`).all(...visited, root.ref_no))];
  res.json(ok({ root, nodes, edges }));
});
L.post('/rel', async (req, res) => {
  const { fromRefNo, toRefNo, relType, remark } = req.body || {};
  if (!fromRefNo || !toRefNo || !relType) throw new BizException('两端单号与关系类型不能为空');
  if (fromRefNo === toRefNo) throw new BizException('禁止自环');
  for (const r of [fromRefNo, toRefNo]) if (!await platform.prepare('SELECT 1 FROM link_node WHERE ref_no=?').get(r)) throw new BizException(`节点 ${r} 不存在`);
  await platform.prepare('INSERT INTO link_rel(from_ref_no,to_ref_no,rel_type,remark) VALUES (?,?,?,?) ON CONFLICT DO NOTHING').run(fromRefNo, toRefNo, relType, remark || '');
  res.json(ok(true));
});
L.delete('/rel/:id', async (req, res) => {
  await platform.prepare('DELETE FROM link_rel WHERE id=?').run(req.params.id);
  res.json(ok(true));
});
// 异常检测转工单（扫取消未退费按患者聚合建 TICKET）
L.post('/auto-ticket', async (req, res) => {
  const his = await businessDb('DS_HIS');
  const rows = await his.prepare(`SELECT f.inhos_no, COUNT(*) fee_cnt, CAST(SUM(f.amount) AS INTEGER) amount
    FROM fee_detail f JOIN medical_order o ON f.order_id=o.order_id
    WHERE o.order_status='2' AND f.fee_status='1' GROUP BY f.inhos_no`).all();
  let created = 0, dateKey = now().slice(0, 10).replace(/-/g, '');
  for (const r of rows) {
    const pat = await his.prepare('SELECT patient_name FROM inpatient WHERE inhos_no=?').get(r.inhos_no);
    const exist = await platform.prepare("SELECT id FROM link_node WHERE ref_no LIKE 'T-AUTO-%' AND payload LIKE ?").get(`%${r.inhos_no}%`);
    if (exist) continue;
    const seq = (await platform.prepare("SELECT COUNT(*) c FROM link_node WHERE ref_no LIKE ?").get(`T-AUTO-${dateKey}-%`)).c + 1;
    const refNo = `T-AUTO-${dateKey}-${String(seq).padStart(3, '0')}`;
    await platform.prepare('INSERT INTO link_node(node_type,ref_no,title,concept_code,status,occurred_at,payload) VALUES (?,?,?,?,?,?,?)')
      .run('TICKET', refNo, `自动检测：取消未退费（${pat ? maskName(pat.patient_name) : r.inhos_no}）`, 'FEE_DETAIL', '待处理', now(),
        JSON.stringify({ inhos_no: r.inhos_no, patient: pat ? maskName(pat.patient_name) : '', feeCount: r.fee_cnt, amount: r.amount }));
    // 回连根因变更
    await platform.prepare(`INSERT INTO link_rel(from_ref_no,to_ref_no,rel_type,remark)
      SELECT ref_no, ?, 'CAUSES', '自动检测关联' FROM link_node WHERE node_type='CHANGE' AND concept_code='LAB_APPLY' ON CONFLICT DO NOTHING`).run(refNo);
    created++;
  }
  res.json(ok({ scanned: rows.length, created }));
});

// ---------- 影响分析 ----------
L.post('/impact/analyze', async (req, res) => {
  const { conceptCode, changeDesc } = req.body || {};
  const depth = Math.min(6, Math.max(1, parseInt(req.body?.depth || '3', 10)));
  const concept = await platform.prepare('SELECT * FROM bm_concept WHERE code=?').get(conceptCode);
  if (!concept) throw new BizException('概念不存在');
  const mappings = await platform.prepare("SELECT * FROM bm_mapping WHERE concept_code=? AND status='ACTIVE'").all(conceptCode);
  const affectedTables = {};
  for (const m of mappings) {
    (affectedTables[m.ds_code] = affectedTables[m.ds_code] || []).push(`${m.table_name}.${m.column_name}${m.value_map ? '（含值字典）' : ''}`);
  }
  const affectedMetrics = await platform.prepare('SELECT metric_code, name FROM bm_metric WHERE concept_code=?').all(conceptCode);
  const testcases = await platform.prepare("SELECT * FROM link_node WHERE concept_code=? AND node_type='TESTCASE'").all(conceptCode);
  // 多跳 BFS
  const relations = await platform.prepare('SELECT * FROM bm_relation').all();
  const hopOf = new Map([[conceptCode, 0]]);
  const queue = [conceptCode];
  const edgeTexts = [];
  const seen = new Set();
  let capped = false;
  while (queue.length) {
    const cur = queue.shift();
    const hop = hopOf.get(cur);
    for (const r of relations) {
      let next = null;
      if (r.from_concept === cur) next = { code: r.to_concept, dir: '下游受影响' };
      else if (r.to_concept === cur) next = { code: r.from_concept, dir: '上游来源' };
      if (!next) continue;
      if (hop >= depth) { capped = true; continue; }
      const ek = `${r.from_concept}|${r.to_concept}|${r.relation_name}|${cur}`;
      if (!seen.has(ek)) { seen.add(ek); edgeTexts.push(`${r.from_concept} —${r.relation_name}→ ${r.to_concept}（${next.dir} · ${hop + 1}跳）`); }
      if (!hopOf.has(next.code)) { hopOf.set(next.code, hop + 1); queue.push(next.code); }
    }
  }
  const impactLayers = {};
  for (const [code, hop] of hopOf) if (hop > 0) (impactLayers[hop] = impactLayers[hop] || []).push(code);
  const history = await platform.prepare("SELECT * FROM link_node WHERE concept_code=? AND node_type IN ('CHANGE','TICKET') ORDER BY occurred_at DESC LIMIT 10").all(conceptCode);
  const adviceLlm = await chat('IMPACT_ADVICE',
    '你是医疗信息化变更评审专家。基于影响面信息输出变更评估意见：一、风险点（按严重度排序）；二、必须同步修改的下游清单；三、测试补充建议。300字以内，直接给结论。',
    `概念：${conceptCode}（${concept.name}）\n变更描述：${changeDesc || ''}\n受影响库表映射：${JSON.stringify(affectedTables)}\n关联指标：${affectedMetrics.map(m => m.name).join('、') || '无'}\n测试用例覆盖：${testcases.length} 条\n上下游关系：${edgeTexts.slice(0, 10).join('；') || '无'}`);
  const advice = adviceLlm || `本次变更涉及 ${Object.keys(affectedTables).length} 个库、${mappings.length} 处映射、${affectedMetrics.length} 个指标。${testcases.length === 0 ? '无测试用例覆盖，必须补充！' : `已有 ${testcases.length} 条用例。`}下游概念 ${Object.keys(impactLayers).reduce((s, h) => s + impactLayers[h].length, 0)} 个，建议按跳层逐级评估。`;
  res.json(ok({
    conceptCode, conceptName: concept.name, changeDesc, affectedTables, affectedMetrics,
    coveredTestcases: testcases, relatedConcepts: [...hopOf.keys()].filter(c => c !== conceptCode),
    impactLayers, impactDepth: depth, impactCapped: capped, history, advice, llmUsed: !!adviceLlm,
  }));
});

// ---------- 证据链 ----------
export const traceRouter = express.Router();
traceRouter.get('/', async (req, res) => {
  const { type, key } = req.query;
  if (!type || !key) throw new BizException('type 与 key 必填');
  if (type === 'QA') {
    const t = await platform.prepare('SELECT * FROM bm_qa_trace WHERE trace_id=?').get(key);
    if (!t) throw new BizException('QA 证据链不存在');
    const spans = [
      { step: 1, title: '提问', detail: t.question, actor: '用户', at: t.created_at },
      { step: 2, title: '语义计划', detail: `${t.plan_mode === 'METRIC' ? '口径卡模式' : '查询模式'}；命中概念：${t.matched_concepts || '无'}；语义：${t.semantics || '-'}`, actor: '语义规划器', at: t.created_at },
      { step: 3, title: '安全校验', detail: t.sql_text ? '只读 SQL + 表/列白名单 + LIMIT 钳制校验通过' : '无 SQL（口径卡/推理模式）', actor: 'SQL 白名单', at: t.created_at },
      { step: 4, title: '真实执行', detail: t.sql_text ? `数据源 ${t.ds_code}；表：${t.used_tables}；返回 ${t.row_count} 行；耗时 ${t.duration_ms}ms` : '口径卡探针实测', actor: '数据面', at: t.created_at },
      { step: 5, title: '结论作答', detail: `${t.answer}（作答来源：${t.answer_source}）`, actor: t.answer_source === 'LLM' ? 'LLM（只表达）' : '规则模板', at: t.created_at },
    ];
    const anchors = [];
    if (t.matched_concepts) for (const c of t.matched_concepts.split(',')) anchors.push({ label: `概念 ${c}`, route: `/ontology?concept=${c}` });
    if (t.ds_code) anchors.push({ label: `数据源 ${t.ds_code}`, route: '/datasource' });
    if (t.matched_docs) for (const d of t.matched_docs.split(',')) anchors.push({ label: `文档 ${d.split(':')[0]}`, route: '/knowledge' });
    res.json(ok({ type, key, summary: `${t.scene === 'ANALYTICS' ? '智能问数' : 'AI 客服'}问答：${t.question.slice(0, 40)}`, spans, anchors, actions: [], refs: [] }));
  } else if (type === 'MAPPING') {
    if (!/^\d+$/.test(String(key))) throw new BizException('映射 ID 必须为数字');
    const m = await platform.prepare('SELECT * FROM bm_mapping WHERE id=?').get(key);
    if (!m) throw new BizException('映射不存在');
    const logs = await platform.prepare('SELECT * FROM bm_mapping_log WHERE mapping_id=? ORDER BY id').all(m.id);
    const spans = logs.length ? logs.map((lg, i) => ({
      step: i + 1, title: lg.action, detail: `操作人 ${lg.operator}；变更：${lg.before_json ? '（前值已留痕）' : '新建'}`,
      actor: lg.operator, at: lg.created_at,
    })) : [{ step: 1, title: 'V30 前存量映射', detail: '无留痕记录', actor: 'system', at: m.created_at }];
    const actions = m.status === 'PROPOSED' ? [{ label: '生效映射', route: '/datasource' }] : m.status === 'ACTIVE' ? [{ label: '查看消费方', route: '/gov' }] : [{ label: '重新激活', route: '/datasource' }];
    res.json(ok({
      type, key, summary: `映射 ${m.ds_code}.${m.table_name}.${m.column_name} → ${m.concept_code}.${m.attr_code}（${m.status}）`,
      spans, anchors: [{ label: `概念 ${m.concept_code}`, route: `/ontology?concept=${m.concept_code}` }, { label: '数据源绑定', route: '/datasource' }], actions, refs: [],
    }));
  } else if (type === 'CONCEPT') {
    const c = await platform.prepare('SELECT * FROM bm_concept WHERE code=?').get(key);
    if (!c) throw new BizException('概念不存在');
    const miss = await platform.prepare("SELECT * FROM bm_ontology_miss WHERE adopted_concept_code=? ORDER BY id DESC LIMIT 1").get(key);
    const attrs = await platform.prepare('SELECT * FROM bm_attribute WHERE concept_code=?').all(key);
    const maps = await platform.prepare("SELECT * FROM bm_mapping WHERE concept_code=? AND status='ACTIVE'").all(key);
    const spans = [];
    if (miss) {
      spans.push({ step: 1, title: '词表缺口回流', detail: `说法「${miss.term}」出现 ${miss.count} 次（来源 ${miss.source}）${miss.revoked ? '，后已撤销' : ''}，采纳为${miss.adopted_as === 'TERM' ? '术语' : '新概念'}`, actor: '本体增长回路', at: miss.first_seen });
    }
    spans.push({ step: spans.length + 1, title: '创建概念', detail: `${c.code}（${c.name}）由${c.owner || '建模员'}创建于 ${c.domain_code} 域`, actor: c.owner || '建模员', at: c.created_at });
    spans.push({ step: spans.length + 1, title: '属性层', detail: attrs.length ? `${attrs.length} 个属性：${attrs.map(a => a.attr_code).join('、')}` : '无属性（CONCEPT_NO_ATTR 门禁会告警）', actor: '建模员', at: c.updated_at });
    spans.push({ step: spans.length + 1, title: '生效映射', detail: maps.length ? `${maps.length} 条 ACTIVE 映射：${[...new Set(maps.map(m => `${m.ds_code}.${m.table_name}`))].join('、')}` : '无生效映射（ATTR_MAPPING_COVERAGE 门禁会告警）', actor: '数据源绑定', at: c.updated_at });
    spans.push({ step: spans.length + 1, title: '状态机', detail: `${c.status}（v${c.version}）；发布需评审员且不得发布本人负责概念`, actor: '评审员', at: c.updated_at });
    res.json(ok({
      type, key, summary: `概念 ${c.code}（${c.name}）全生命周期`,
      spans, anchors: [{ label: '概念详情', route: `/ontology?concept=${c.code}` }, { label: '数据源绑定', route: '/datasource' }],
      actions: miss && !miss.revoked ? [{ label: '撤销采纳', route: '/evolve' }] : [], refs: [],
    }));
  } else throw new BizException(`未知证据链类型 ${type}`);
});

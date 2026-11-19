import express from 'express';
import { platform, now, businessDb, probeOne } from './db.js';
import { config } from './config.js';
import { BizException, ok, validateSql, maskPatientRows, maskName } from './common.js';
import { chat, parseJsonLoose } from './llm.js';
import { getMetric, evaluateMetric, listProbed } from './metric.js';
import { recordMiss, pendingMissCount } from './ontology.js';
import { knowledgeSearch, entryContent, basisEntries } from './knowledge.js';
import { runRca, enhanceRcaWithLlm } from './rca.js';

export const csRouter = express.Router();
const R = csRouter;

// ============================================================
// 路由（LLM 优先 + 关键词规则兜底 + 错例反馈回路）
// ============================================================
const CS_INTENTS = ['FEE', 'DISPENSE_PAY', 'DISPENSE_SPLIT', 'DISPENSE_RETURN', 'MATERIAL', 'STAFF', 'GLOSSARY', 'SEMANTIC_QUERY', 'DOC_QA'];
const KEYWORD_ROUTE = [
  [/口径|怎么算|如何计算|什么是|什么叫|定义|指标/, 'GLOSSARY'],
  [/取消.*退|退.*费|收费|计费|投诉|多收/, 'FEE'],
  [/缴费.*(发药|药)|发药.*(缴费|钱)|先药后费|未缴费.*(发|取)/, 'DISPENSE_PAY'],
  [/分次|多次发药|两次发药/, 'DISPENSE_SPLIT'],
  [/退药/, 'DISPENSE_RETURN'],
  [/耗材|物资|库存|申领/, 'MATERIAL'],
  [/哪个科室|谁.*医生|护士.*谁|人员|工号/, 'STAFF'],
  [/多少|几|统计|查询|多少笔|多少人次|多少钱|金额/, 'SEMANTIC_QUERY'],
  [/制度|规定|流程|文档|管理办法|通告|规范/, 'DOC_QA'],
];
function routeByRule(q) {
  for (const [re, intent] of KEYWORD_ROUTE) if (re.test(q)) return intent;
  return null;
}
async function routeAsk(q, scene) {
  const feedbacks = await platform.prepare('SELECT question, intent, comment FROM bm_cs_feedback WHERE correct=0 ORDER BY id DESC LIMIT 10').all();
  const feedbackText = feedbacks.length
    ? `\n\n【用户纠错反馈（避免再次误判）】\n${feedbacks.map(f => `- 「${f.question}」曾被误判为 ${f.intent}${f.comment ? `（正确说法：${f.comment}）` : ''}`).join('\n')}` : '';
  if (scene === 'ANALYTICS') {
    const llm = await chat('CS_ROUTE', '你是意图分类器，只输出标签本身，不要任何其他文字。',
      `标签：GLOSSARY（问指标口径/定义/怎么算）、SEMANTIC_QUERY（开放业务数据查询）\n问题：「${q}」${feedbackText}\n只输出标签。`);
    const tag = String(llm || '').replace(/[^A-Z_]/g, '');
    if (['GLOSSARY', 'SEMANTIC_QUERY'].includes(tag)) return { intent: tag, router: 'LLM' };
    const rule = routeByRule(q);
    if (rule === 'GLOSSARY' || rule === 'DOC_QA' || rule === 'FEE') return { intent: 'GLOSSARY', router: 'RULE' };
    return { intent: 'SEMANTIC_QUERY', router: rule ? 'RULE' : 'SEMANTIC' };
  }
  const llm = await chat('CS_ROUTE',
    '你是医院数据问答的意图分类器，只输出标签本身，不要任何其他文字。',
    `可选标签：\nFEE 取消/退费/计费投诉\nDISPENSE_PAY 缴费与发药双向核对\nDISPENSE_SPLIT 分次发药\nDISPENSE_RETURN 退药\nMATERIAL 耗材/物资库存申领\nSTAFF 人员归属/科室\nGLOSSARY 口径/指标定义\nSEMANTIC_QUERY 开放业务事实查询\nDOC_QA 制度文档问答\n\n辨析：「检验取消了怎么还收费」→FEE；「已缴费未发药正常吗」→DISPENSE_PAY；「多个患者的处方合并结算」→SEMANTIC_QUERY${feedbackText}\n\n问题：「${q}」\n只输出标签。`);
  const tag = String(llm || '').replace(/[^A-Z_]/g, '');
  if (CS_INTENTS.includes(tag)) return { intent: tag, router: 'LLM' };
  const rule = routeByRule(q);
  if (rule) return { intent: rule, router: 'RULE' };
  return { intent: null, router: 'NONE' };
}

function capabilityMenu(q) {
  return {
    intent: null, router: 'REFERRAL',
    answer: '这个问题我答不了。我能做：① 取消/退费投诉诊断（FEE）；② 缴费×发药跨库核对；③ 口径与指标解释（GLOSSARY）；④ 结构化业务查询（SEMANTIC_QUERY）；⑤ 制度文档问答（DOC_QA）。找数据？去「智能问数」。',
    links: [{ label: '去智能问数', route: `/ask?q=${encodeURIComponent(q)}` }, { label: '看统一口径', route: '/glossary' }],
  };
}
async function analyticsMenu(q) {
  const count = await platform.prepare("SELECT COUNT(*) c FROM bm_concept WHERE status='PUBLISHED'").get();
  return {
    intent: null, router: 'REFERRAL',
    answer: `语义层已发布概念 ${count.c} 个。你可以问：出院多少人、检验撤销率、均次费用等；复杂业务问题请转 AI 客服。`,
    links: [{ label: '去 AI 客服', route: `/cs?q=${encodeURIComponent(q)}` }],
  };
}

// ============================================================
// 口径卡 / 术语解答（GLOSSARY）
// ============================================================
function cjkBigrams(s) {
  const out = [];
  const segRe = /[\u4e00-\u9fa5]+|[a-zA-Z0-9]+/g;
  let m;
  while ((m = segRe.exec(String(s)))) {
    const seg = m[0];
    if (/^[\u4e00-\u9fa5]+$/.test(seg)) for (let i = 0; i + 1 < seg.length; i++) out.push(seg.slice(i, i + 2));
    else if (seg.length >= 2) out.push(seg.toLowerCase());
  }
  return out;
}
async function prefilterMetricCards(q) {
  const qb = cjkBigrams(q);
  if (!qb.length) return [];
  const cards = [];
  for (const m of await listProbed()) {
    const tb = cjkBigrams(`${m.name} ${m.definition || ''}`);
    const overlap = qb.filter(b => tb.includes(b)).length;
    if (overlap >= 2) cards.push(m);
    if (cards.length >= 5) break;
  }
  return cards;
}
async function glossaryAnswer(q, scene, recordMissFlag = true, allowCard = true) {
  // 指标直命中 → 口径卡
  const metric = await platform.prepare('SELECT * FROM bm_metric WHERE name=? OR metric_code=?').get(q.trim(), q.trim());
  if (metric) return metricCardAnswer(metric, scene);
  if (allowCard) {
    const scored = (await prefilterMetricCards(q))
      .map(m => ({ m, overlap: cjkBigrams(q).filter(b => cjkBigrams(`${m.name} ${m.definition || ''}`).includes(b)).length }))
      .sort((a, b) => b.overlap - a.overlap);
    if (scored.length && q.includes(scored[0].m.name)) return metricCardAnswer(scored[0].m, scene);
  }
  // 术语/概念命中
  const term = await platform.prepare('SELECT t.*, c.name AS concept_name, c.definition AS concept_def, c.code AS concept_code FROM bm_term t JOIN bm_concept c ON c.code=t.concept_code WHERE t.term=?').get(q.trim());
  const concept = term ? null : await platform.prepare('SELECT * FROM bm_concept WHERE name=? OR code=?').get(q.trim(), q.trim());
  if (term || concept) {
    const c = term || concept;
    const code = term ? term.concept_code : concept.code;
    const rels = await platform.prepare('SELECT * FROM bm_relation WHERE from_concept=? OR to_concept=?').all(code, code);
    const llm = await chat('SEARCH_ANSWER', '你是口径解答助手。严格基于给定定义回答，200字以内，不要编造。',
      `术语：「${term ? term.term : concept.name}」→ 概念 ${code}（${term ? term.concept_name : concept.name}）\n定义：${term ? term.concept_def : concept.definition}\n关联关系：${rels.map(r => `${r.from_concept} —${r.relation_name}→ ${r.to_concept}`).join('；') || '无'}\n\n问题：「${q}」`);
    return {
      intent: 'GLOSSARY', router: 'SEMANTIC',
      answer: llm || `「${term ? term.term : concept.name}」对应标准概念【${term ? term.concept_name : concept.name}】：${term ? term.concept_def : concept.definition}`,
      evidence: [['标准概念', `${code} ${term ? term.concept_name : concept.name}`], ['业务定义', term ? term.concept_def : concept.definition]],
      links: [{ label: '查看概念', route: `/ontology?concept=${code}` }],
    };
  }
  if (recordMissFlag) recordMiss(q.trim().slice(0, 64), 'CONCEPT', scene === 'CS' ? 'CS_ASK' : 'QA_ASK');
  return null;
}
async function metricCardAnswer(m, scene) {
  const evaled = await evaluateMetric(m.metric_code);
  const group = await platform.prepare("SELECT group_code, dispute_status, verdict FROM bm_reconcile_group WHERE ',' || metric_codes || ',' LIKE ?").get(`%,${m.metric_code},%`);
  return {
    intent: 'GLOSSARY', router: scene === 'CS' ? 'SEMANTIC' : 'RULE',
    answer: `【口径卡】${m.name}（${m.metric_code}）：${m.definition || '（无定义）'}`,
    metric: {
      metricCode: m.metric_code, name: m.name, definition: m.definition, formula: m.formula,
      dsCode: m.ds_code, probeSql: m.probe_sql, owner: m.owner, warnThreshold: m.warn_threshold,
      lastVal: evaled.value, lastEvalAt: evaled.metric.last_eval_at, error: evaled.error || null,
      reconciled: group ? { groupCode: group.group_code, disputeStatus: group.dispute_status, verdict: group.verdict } : null,
    },
    evidence: [['口径定义', m.definition || ''], ['计算公式', m.formula || ''], ['探针 SQL', m.probe_sql || ''], ['负责人', m.owner || '']],
    links: [{ label: '统一口径', route: '/glossary' }],
  };
}

// ============================================================
// 跨库核对：六语义档（专家预定义，LLM 不参与判定）
// ============================================================
const NIGHTLY_END_HOUR = 6;
export async function reconcileDispensePay() {
  const runId = `RECON-${now().replace(/[-: ]/g, '')}-${Math.random().toString(36).slice(2, 8)}`;
  const tiers = [];
  const diffs = [];
  const usedOrders = new Set();
  const push = async (direction, stateCode, rows, note) => {
    const t = TIERS[stateCode];
    const attribution = await attributionOf(stateCode);
    tiers.push({ direction, stateCode, severity: t.severity, attribution, suggestedAction: t.action, count: rows.length, note });
    for (const r of rows) diffs.push({ runId, direction, stateCode, severity: t.severity, attribution, suggestedAction: t.action, ...r });
  };
  const his = await businessDb('DS_HIS'), ph = await businessDb('DS_PHARMACY'), charge = await businessDb('DS_CHARGE');
  // A 向：已发药但患者无任何有效缴费
  const paidRows = await charge.prepare("SELECT DISTINCT inhos_no FROM pay_record WHERE pay_type IN ('1','2','4')").all();
  const paid = new Set(paidRows.map(r => r.inhos_no));
  const dispensed = await ph.prepare("SELECT dispense_id, order_id, patient_no, item_name FROM dispense_record WHERE status='1'").all();
  await push('A', 'VIOLATION_PREPAY_BYPASS', dispensed.filter(r => !paid.has(r.patient_no)));
  // A 向：已退药但费用未退费
  const refundedRows = await his.prepare("SELECT order_id FROM fee_detail WHERE fee_status='2'").all();
  const refundedOrders = new Set(refundedRows.map(r => r.order_id));
  const returnedRows = await ph.prepare("SELECT dispense_id, order_id, patient_no, item_name FROM dispense_record WHERE status='2'").all();
  const returned = returnedRows
    .filter(r => !refundedOrders.has(r.order_id));
  for (const r of returned) usedOrders.add(r.order_id);
  await push('A', 'RETURNED_PENDING_REFUND', returned);
  // B 向：药品医嘱 × 费用 × 发药
  const dispenseOrderRows = await ph.prepare("SELECT DISTINCT order_id FROM dispense_record WHERE status IN ('0','1')").all();
  const dispensedOrders = new Set(dispenseOrderRows.map(r => r.order_id));
  const bRows = await his.prepare(`SELECT o.order_id, o.inhos_no, o.item_name, o.order_status, o.cancel_time, f.fee_status
    FROM medical_order o JOIN fee_detail f ON f.order_id=o.order_id WHERE o.order_type='药品'`).all();
  const stuck = [], inflight = [], cancelledAfter = [], nightly = [];
  for (const r of bRows) {
    if (usedOrders.has(r.order_id) || dispensedOrders.has(r.order_id)) continue; // 一笔业务只进一档
    if (r.order_status === '0' && paid.has(r.inhos_no)) { inflight.push(r); continue; }
    if (r.order_status === '1' && r.fee_status === '1' && paid.has(r.inhos_no)) { stuck.push(r); continue; }
    if (r.order_status === '2') {
      const hour = parseInt(String(r.cancel_time || '').slice(11, 13) || '12', 10);
      if (hour < NIGHTLY_END_HOUR) { nightly.push(r); continue; }
      if (r.fee_status === '1') cancelledAfter.push(r);
    }
  }
  await push('B', 'STUCK_BACKLOG', stuck);
  await push('B', 'IN_FLIGHT', inflight);
  await push('B', 'CANCELLED_AFTER_PAY', cancelledAfter);
  await push('B', 'NIGHTLY_CANCEL', nightly);
  // 落库 + 清理 7 天前旧批次
  for (const d of diffs) await platform.prepare('INSERT INTO bm_recon_diff(run_id,direction,state_code,severity,attribution,suggested_action,patient_no,order_id,item_name) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(d.runId, d.direction, d.stateCode, d.severity, d.attribution, d.suggestedAction, d.patient_no || d.inhos_no || null, d.order_id || null, d.item_name || null);
  await platform.prepare(`DELETE FROM bm_recon_diff WHERE created_at < NOW() - INTERVAL '7 days'`).run();
  const abnormalCount = diffs.filter(d => !['IN_FLIGHT', 'NIGHTLY_CANCEL'].includes(d.stateCode)).length;
  return { runId, tiers, diffs, registered: diffs.length, abnormalCount };
}
const TIERS = {
  VIOLATION_PREPAY_BYPASS: { severity: 'VIOLATION', action: '逐笔追缴并核查发药窗口放行原因' },
  RETURNED_PENDING_REFUND: { severity: 'WATCH', action: '触发退费流程，核对退费时效' },
  STUCK_BACKLOG: { severity: 'WATCH', action: '催办药房发药或发起退费' },
  IN_FLIGHT: { severity: 'NORMAL', action: '无需处理，显式登记防止误判为滞留' },
  CANCELLED_AFTER_PAY: { severity: 'WATCH', action: '人工核对退费是否完成' },
  NIGHTLY_CANCEL: { severity: 'NORMAL', action: '归因消除，不进异常清单' },
};
async function attributionOf(stateCode) {
  const fromKb = await entryContent(`RECON_ATTR_${stateCode}`);
  if (fromKb) return fromKb.split('。')[0] + '。';
  return {
    VIOLATION_PREPAY_BYPASS: '已发药但患者无任何有效缴费记录，先药后费违反流程公理。',
    RETURNED_PENDING_REFUND: '已退药但对应费用未退费——业务完成≠财务到账的中间态。',
    STUCK_BACKLOG: '已计费已缴费且医嘱已执行，但药房无发药记录——真实滞留。',
    IN_FLIGHT: '已缴费但医嘱未执行——在途待发，属正常差异。',
    CANCELLED_AFTER_PAY: '缴费后医嘱被取消（非凌晨批量窗口）。',
    NIGHTLY_CANCEL: '凌晨批量取消窗口内的自然取消（未缴费超时自动取消）。',
  }[stateCode] || '';
}

// ============================================================
// 各意图回答
// ============================================================
async function feeAnswer() {
  const his = await businessDb('DS_HIS');
  const row = await his.prepare(`SELECT COUNT(DISTINCT f.inhos_no) patient_cnt, COUNT(*) fee_cnt, CAST(SUM(f.amount) AS INTEGER) total_amount
    FROM fee_detail f JOIN medical_order o ON f.order_id=o.order_id WHERE o.order_status='2' AND f.fee_status='1'`).get();
  const rootCause = await entryContent('CS_RULE_FEE_ROOT') || 'LIS v5.2 升级后撤销码 X→C，HIS 计费适配器未同步配置 C 码退费映射。';
  return {
    intent: 'FEE', router: 'SEMANTIC',
    answer: `经排查，全院共有 ${row.patient_cnt} 名患者、${row.fee_cnt} 笔「医嘱已取消但费用仍正常计费」记录，合计 ¥${row.total_amount}。根因：${rootCause} 已生成根因分析并支持一键处置退费。`,
    evidence: [['影响患者', `${row.patient_cnt} 名`], ['涉及费用', `${row.fee_cnt} 笔 / ¥${row.total_amount}`], ['根因条目', 'CS_RULE_FEE_ROOT']],
    links: [{ label: '去工单诊断', route: '/cs' }, { label: '看数据治理', route: '/gov' }],
  };
}
async function dispenseSplitAnswer() {
  const ph = await businessDb('DS_PHARMACY');
  const rows = await ph.prepare(`SELECT order_id, COUNT(*) cnt FROM dispense_record GROUP BY order_id HAVING COUNT(*) > 1 LIMIT 10`).all();
  return {
    intent: 'DISPENSE_SPLIT', router: 'SEMANTIC',
    answer: rows.length
      ? `存在 ${rows.length} 条医嘱存在分次发药（一条医嘱对应多条发药记录），例如：${rows.slice(0, 3).map(r => r.order_id).join('、')}。医嘱—发药是 1:N 关系，允许分次发药。`
      : '当前演示数据中暂未出现分次发药。医嘱—发药是 1:N 关系，允许分次发药，核对时需按医嘱号分组判断。',
    evidence: [['知识依据', 'CS_RULE_DISPENSE_SPLIT']],
    links: [{ label: '去链路追溯', route: '/link' }],
  };
}
async function dispenseReturnAnswer() {
  const ph = await businessDb('DS_PHARMACY');
  const returnedRow = await ph.prepare("SELECT COUNT(*) c FROM dispense_record WHERE status='2'").get();
  const his = await businessDb('DS_HIS');
  const refundedRow = await his.prepare("SELECT COUNT(*) c FROM fee_detail WHERE fee_status='2'").get();
  const returned = returnedRow.c;
  const refunded = refundedRow.c;
  return {
    intent: 'DISPENSE_RETURN', router: 'SEMANTIC',
    answer: `已退药记录 ${returned} 条；已退费费用 ${refunded} 条。退药与退费必须成对（先退药后退费），差异部分走跨库核对六档语义定位。`,
    evidence: [['退药', `${returned} 条`], ['退费', `${refunded} 条`], ['知识依据', 'CS_RULE_REFUND_PAIR']],
    links: [{ label: '跨库核对差异', route: '/cs' }],
  };
}
async function materialAnswer() {
  const ph = await businessDb('DS_PHARMACY');
  const lowRow = await ph.prepare('SELECT COUNT(*) c FROM drug_stock WHERE quantity<=50').get();
  const mat = await businessDb('DS_MATERIAL');
  const matsRow = await mat.prepare('SELECT COUNT(*) c FROM material_stock WHERE quantity < 100').get();
  const low = lowRow.c;
  const mats = matsRow.c;
  return {
    intent: 'MATERIAL', router: 'SEMANTIC',
    answer: `药品库存：低库存（≤50）药品 ${low} 种；物资库存：低于 100 的物资 ${mats} 种。库存账实规则（GOV-007/011）可一键核验。`,
    evidence: [['低库存药品', String(low)], ['低库存物资', String(mats)]],
    links: [{ label: '数据治理扫描', route: '/gov' }, { label: '推演沙盘', route: '/simulation' }],
  };
}
async function staffAnswer(q) {
  const name = (q.match(/([\u4e00-\u9fa5]{2,3})(?:医生|护士|药师|的)?/) || [])[1] || '';
  const his = await businessDb('DS_HIS');
  const staff = await his.prepare('SELECT * FROM staff WHERE staff_name LIKE ?').all(`%${name.slice(-2)}%`);
  if (!staff.length) {
    return { intent: 'STAFF', router: 'SEMANTIC', answer: `未在人员主数据中找到「${name}」，主数据覆盖缺口，建议补录。`, evidence: [], links: [] };
  }
  const s = staff[0];
  const dept = await his.prepare('SELECT * FROM dept WHERE dept_code=?').get(s.dept_code);
  return {
    intent: 'STAFF', router: 'SEMANTIC',
    answer: `${s.staff_name}（${s.staff_id}）：${s.title}，${s.role}，所属「${dept?.dept_name || s.dept_code}」${dept ? `（${dept.ward || dept.category}）` : ''}。可下钻查看跨系统业务足迹。`,
    evidence: [['科室', dept?.dept_name || s.dept_code], ['角色', s.role]],
    links: [{ label: '医嘱闭环人员下钻', route: `/flow?staff=${encodeURIComponent(s.staff_name)}` }],
  };
}
async function docQaAnswer(q) {
  const hits = await knowledgeSearch(q, 5);
  if (!hits.length) {
    recordMiss(q.trim().slice(0, 64), 'KNOWLEDGE', 'CS_ASK');
    return { intent: 'DOC_QA', router: 'SEMANTIC', answer: '知识库暂无相关制度依据（已回流知识缺口）。', evidence: [], links: [{ label: '知识库', route: '/knowledge' }] };
  }
  const context = hits.map(h => `《${h.docTitle}》${h.heading}：${h.content}`).join('\n---\n');
  const llm = await chat('CS_DOC_ANSWER', '你是医院制度问答助手。严格基于给定制度片段回答，不编造片段之外的条文，150字以内。',
    `制度片段：\n${context}\n\n问题：「${q}」`);
  const first = hits[0];
  return {
    intent: 'DOC_QA', router: 'SEMANTIC',
    answer: llm || `依据《${first.docTitle}》${first.heading}：${first.content.slice(0, 200)}`,
    evidence: hits.map(h => [`《${h.docTitle}》${h.heading}`, `doc:${h.documentId}:${h.seq}`]),
    links: [{ label: '知识库', route: '/knowledge' }],
  };
}
async function semanticModelAnswer(q) {
  const concepts = await platform.prepare("SELECT c.code, c.name, c.definition, c.domain_code FROM bm_concept c WHERE c.status='PUBLISHED' ORDER BY c.code").all();
  const rels = await platform.prepare('SELECT * FROM bm_relation').all();
  const llm = await chat('CS_SEMANTIC_PLAN',
    '你是本体语义推理器。基于本体结构回答业务规则问题，只返回 JSON。',
    `【本体概念】${concepts.map(c => `${c.code}(${c.name})：${c.definition || ''}`).join('；')}\n【概念关系】${rels.map(r => `${r.from_concept} —${r.relation_name}→ ${r.to_concept}`).join('；')}\n\n问题：「${q}」\n按本体结构与已发布动作推理，返回 {"mode":"MODEL_ANSWER","conclusion":"可以/不可以/…","semantics":"推理依据（引用概念与关系）"}。`);
  const p = parseJsonLoose(llm);
  if (p && p.conclusion) {
    return {
      intent: 'SEMANTIC_QUERY', router: 'SEMANTIC', mode: 'MODEL_ANSWER',
      answer: `${p.conclusion}（依据：${p.semantics || '本体结构与已发布动作'}）`,
      semantics: p.semantics, matchedConcepts: concepts.filter(c => q.includes(c.name)).slice(0, 6).map(c => c.code),
      evidence: [], links: [{ label: '本体管理', route: '/ontology' }],
    };
  }
  return {
    intent: 'SEMANTIC_QUERY', router: 'SEMANTIC', mode: 'MODEL_ANSWER',
    answer: '该问题需要结合本体结构与已发布动作推理。请到「本体管理」确认相关概念与动作后重试，或换一种问法。',
    evidence: [], links: [{ label: '本体管理', route: '/ontology' }],
  };
}

// ============================================================
// 语义问数（ANALYTICS：Ontology2SQL）
// ============================================================
function sceneDsList() { return config.semanticSceneDs; }
async function buildSemanticContext() {
  const scene = sceneDsList();
  const conceptRows = await platform.prepare("SELECT code, name, definition FROM bm_concept WHERE status='PUBLISHED' ORDER BY code").all();
  const conceptParts = [];
  for (const c of conceptRows) {
    const attrs = await platform.prepare('SELECT attr_code, attr_name, data_type FROM bm_attribute WHERE concept_code=? ORDER BY sort').all(c.code);
    conceptParts.push(`${c.code}(${c.name})：${attrs.map(a => `${a.attr_code}[${a.data_type}]`).join(',')}`);
  }
  const concepts = conceptParts.join('\n');
  const rels = (await platform.prepare('SELECT * FROM bm_relation').all()).map(r => `${r.from_concept} —${r.relation_name}→ ${r.to_concept}`).join('；');
  const mappings = await platform.prepare(`SELECT * FROM bm_mapping WHERE status='ACTIVE' AND ds_code IN (${scene.map(() => '?').join(',')}) ORDER BY ds_code, table_name`).all(...scene);
  const byDs = new Map();
  for (const m of mappings) {
    const k = m.ds_code;
    if (!byDs.has(k)) byDs.set(k, new Map());
    const t = byDs.get(k);
    if (!t.has(m.table_name)) t.set(m.table_name, []);
    t.get(m.table_name).push(m);
  }
  let phys = '';
  for (const [ds, tables] of byDs) {
    phys += `数据源 ${ds}：\n`;
    for (const [t, cols] of tables) {
      phys += `  表 ${t}：${cols.map(c => `${c.column_name}→${c.concept_code}.${c.attr_code}${c.value_map ? `(枚举:${c.value_map})` : ''}`).join(', ')}\n`;
    }
  }
  if (!phys) phys = '（场景内数据源暂无生效映射：查数类问题回答不了，按规则返回 UNANSWERABLE，严禁编造数据源或表名）';
  return { concepts, rels, phys };
}
async function allowedTablesCols(ds) {
  const rows = await platform.prepare("SELECT * FROM bm_mapping WHERE status='ACTIVE' AND ds_code=?").all(ds);
  return {
    tables: [...new Set(rows.map(r => r.table_name))],
    cols: [...new Set(rows.map(r => r.column_name).concat(rows.map(r => r.attr_code)))].filter(Boolean),
  };
}
async function persistQaTrace(scene, q, plan, rows, answer, answerSource, durationMs, extra = {}) {
  const traceId = `QA-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  await platform.prepare(`INSERT INTO bm_qa_trace(trace_id,scene,question,ds_code,used_tables,sql_text,semantics,matched_concepts,matched_docs,plan_mode,row_count,answer,answer_source,duration_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    traceId, scene, q, plan.ds || null, plan.usedTables || null, plan.sql || null, plan.semantics || null,
    (extra.matchedConcepts || []).join(',') || null, (extra.matchedDocs || []).join(',') || null,
    plan.mode === 'METRIC' ? 'METRIC' : (plan.mode === 'QUERY' ? 'QUERY' : plan.mode || 'QUERY'),
    rows != null ? rows.length : null, answer, answerSource, durationMs);
  return traceId;
}

async function planQuery(q, scene) {
  const started = Date.now();
  const ctx = await buildSemanticContext();
  const cards = await prefilterMetricCards(q);
  const cardText = cards.length ? `\n【在册口径卡】${cards.map(m => `${m.metric_code}(${m.name})：${m.definition}`).join('；')}` : '';
  const today = now().slice(0, 10);
  const llm = await chat('CS_SEMANTIC_PLAN',
    '你是本体语义查询规划器。把自然语言转换为只读 SQL 或结构化计划，只返回 JSON，不要多余文字。',
    `【本体概念】\n${ctx.concepts}\n\n【物理映射（仅场景内数据源，只允许用这里的库/表/列）】\n${ctx.phys}\n\n【概念关系】${ctx.rels}${cardText}\n\n规则：\n1 ds/表/列只能取物理映射段；枚举列的中文需反解为原始码；\n2 生成以 SELECT 开头的 PostgreSQL 只读 SQL，末尾 LIMIT≤100；日期用 to_char/EXTRACT；\n3 今天是 ${today}；\n4 问口径/定义 → mode=GLOSSARY 类问题直接给 metrics 或走 GLOSSARY；问题恰是某口径卡所指指标本身（不带科室/时段限定）→ mode=METRIC 并返回 metrics:["指标编码"]；\n5 业务规则/能不能类问题 → mode=MODEL_ANSWER；\n6 答不了（信息不足=AMBIGUITY，词表没有=VOCABULARY；平台故障=VOCABULARY）→ mode=UNANSWERABLE 并给 gapType 与 reason；\n7 QUERY 模式返回 {"mode":"QUERY","ds":"数据源编码","sql":"...","semantics":"查询逻辑说明"}。\n\n问题：「${q}」`);
  const p = parseJsonLoose(llm);
  if (!p || !p.mode) return null; // LLM 不可用/解析失败 → 能力菜单（非语义层缺口，不记 miss）
  return { plan: p, started };
}

async function executeQueryPlan(plan) {
  if (!plan.ds || !plan.sql) throw new BizException('查询计划缺少数据源或 SQL');
  const scene = sceneDsList();
  if (scene.length && !scene.includes(plan.ds)) throw new BizException(`数据源 ${plan.ds} 不在问数场景清单内`);
  const { tables, cols } = await allowedTablesCols(plan.ds);
  if (!tables.length) throw new BizException(`数据源 ${plan.ds} 无生效映射，拒绝执行`);
  const safeSql = validateSql(plan.sql, tables, cols);
  const db = await businessDb(plan.ds);
  const rows = await db.prepare(safeSql).all();
  return { safeSql, rows: rows.slice(0, 100), tables };
}

export async function analyticsAsk(q) {
  // 口径前置试探：仅指标名称直命中才出卡提前返回
  const metricHit = await platform.prepare('SELECT * FROM bm_metric WHERE name=?').get(q.trim());
  if (metricHit) {
    const card = await metricCardAnswer(metricHit, 'ANALYTICS');
    const traceId = await persistQaTrace('ANALYTICS', q, { mode: 'GLOSSARY' }, null, card.answer, 'TEMPLATE', 0);
    return { ...card, traceId };
  }
  const planned = await planQuery(q, 'ANALYTICS');
  if (!planned) {
    // LLM 不可用：规则兜底——口径卡直命中（router=RULE，诚实标注）
    const cards = (await prefilterMetricCards(q)).filter(m => q.includes(m.name.slice(0, Math.max(2, m.name.length - 1))) || m.name.includes(q.slice(0, 6)));
    if (cards.length) {
      const m = cards[0];
      const a = await metricCardAnswer(m, 'ANALYTICS');
      const traceId = await persistQaTrace('ANALYTICS', q, { mode: 'GLOSSARY' }, null, a.answer, 'TEMPLATE', 0);
      return { ...a, router: 'RULE', ruleFallback: true, traceId };
    }
    return { ...await analyticsMenu(q), parseEmpty: true };
  }
  const { plan } = planned;
  const duration = Date.now() - planned.started;

  if (plan.mode === 'METRIC') {
    const codes = Array.isArray(plan.metrics) ? plan.metrics : [];
    const cards = (codes.length ? (await Promise.all(codes.map(c => getMetric(c)))).filter(Boolean) : await prefilterMetricCards(q)).slice(0, 5);
    if (!cards.length) return { ...await analyticsMenu(q), parseEmpty: true };
    const results = [];
    for (const m of cards) {
      const ev = await evaluateMetric(m.metric_code);
      const group = await platform.prepare("SELECT group_code, dispute_status FROM bm_reconcile_group WHERE ',' || metric_codes || ',' LIKE ?").get(`%,${m.metric_code},%`);
      results.push({ metricCode: m.metric_code, name: m.name, definition: m.definition, formula: m.formula, dsCode: m.ds_code, probeSql: m.probe_sql, owner: m.owner, warnThreshold: m.warn_threshold, lastVal: ev.value, error: ev.error || null, reconciled: group || null });
    }
    const answer = results.map(r => `${r.name}: ${r.error ? `（探针失败：${r.error}）` : r.lastVal}`).join('；') + '。（口径卡实测，非现场编造）';
    const traceId = await persistQaTrace('ANALYTICS', q, { mode: 'METRIC', semantics: '口径卡探针实测' }, null, answer, 'TEMPLATE', duration);
    return { intent: 'GLOSSARY', router: 'SEMANTIC', mode: 'METRIC', answer, metricCards: results, traceId, links: [{ label: '统一口径', route: '/glossary' }] };
  }
  if (plan.mode === 'MODEL_ANSWER') {
    const answer = plan.conclusion ? `${plan.conclusion}（${plan.semantics || ''}）` : (plan.semantics || '按本体结构推理，无法给出确定结论。');
    let verifyNote = null;
    if (plan.verifySql) {
      try {
        const { rows } = await executeQueryPlan({ ds: plan.ds, sql: plan.verifySql });
        verifyNote = `探针实证：${rows.length} 行`;
      } catch (e) { verifyNote = `探针校验未通过（${e.message}），保留结构结论`; }
    }
    const traceId = await persistQaTrace('ANALYTICS', q, { mode: 'MODEL_ANSWER', semantics: plan.semantics, sql: plan.verifySql, ds: plan.ds }, null, answer, 'TEMPLATE', duration);
    return {
      intent: 'SEMANTIC_QUERY', router: 'SEMANTIC', mode: 'MODEL_ANSWER', answer: answer + (verifyNote ? ` ${verifyNote}` : ''),
      semantics: plan.semantics, traceId, links: [{ label: '本体管理', route: '/ontology' }],
    };
  }
  if (plan.mode === 'UNANSWERABLE') {
    const gapType = plan.gapType === 'AMBIGUITY' ? 'AMBIGUITY' : 'VOCABULARY';
    if (gapType === 'AMBIGUITY') {
      const clarifyQ = plan.reason ? `需要补充信息：${plan.reason}。请补充时间范围/科室/对象/口径。` : '需要补充信息：请说明时间范围、科室或具体对象。';
      const r = await platform.prepare('INSERT INTO bm_clarify_task(scene,origin_question,reason,gap_type,clarify_question,status,rounds) VALUES (?,?,?,?,?,?,1)')
        .run('ANALYTICS', q, plan.reason || '', 'AMBIGUITY', clarifyQ);
      return {
        intent: 'SEMANTIC_QUERY', router: 'SEMANTIC', mode: 'UNANSWERABLE', clarify: {
          id: r.lastInsertRowid, clarifyQuestion: clarifyQ, reason: plan.reason || '', rounds: 1,
        },
        answer: clarifyQ, traceId: null, links: [],
      };
    }
    recordMiss(q.trim().slice(0, 64), 'QUESTION', 'QA_ASK');
    return {
      intent: 'SEMANTIC_QUERY', router: 'SEMANTIC', mode: 'UNANSWERABLE',
      unanswered: true,
      answer: `答不了：${plan.reason || '语义层词表暂未覆盖该说法'}。已回流本体增长回路（概念缺口），由建模员人工采纳。`,
      traceId: null, links: [{ label: '查看概念缺口', route: '/evolve' }],
    };
  }
  // QUERY 模式
  try {
    const { safeSql, rows, tables } = await executeQueryPlan(plan);
    const masked = maskPatientRows(rows);
    const llm = await chat('CS_SEMANTIC_ANSWER', '你是数据问答助手。严格基于查询结果作答：先给结论再给关键数字，结果里没有的信息不要编造，200字以内。',
      `问题：「${q}」\n查询结果（前20行，已脱敏）：\n${JSON.stringify(masked.slice(0, 20)).slice(0, 3000)}`);
    const answer = llm || templateAnswer(q, rows);
    const matchedConcepts = await matchConcepts(q);
    const traceId = await persistQaTrace('ANALYTICS', q, { ...plan, sql: safeSql, usedTables: tables.join(',') }, rows, answer, llm ? 'LLM' : 'TEMPLATE', Date.now() - planned.started, { matchedConcepts });
    return {
      intent: 'SEMANTIC_QUERY', router: 'SEMANTIC', mode: 'QUERY', answer,
      parse: { semantics: plan.semantics, sql: safeSql, ds: plan.ds, rows: masked.slice(0, 20), rowCount: rows.length, matchedConcepts },
      traceId, links: [{ label: '证据链', route: `/trace?type=QA&key=${traceId}` }],
    };
  } catch (e) {
    console.error('[SemanticQA] QUERY 执行失败:', e.message, '| ds =', plan.ds, '| sql =', plan.sql);
    // 协议纠错一次：把 PG 报错回喂 LLM 修复 SQL，修复后仍失败才降级
    try {
      const ctx = await buildSemanticContext();
      const fixLlm = await chat('CS_SEMANTIC_PLAN',
        '你修复 PostgreSQL SQL 语法错误。只返回 JSON：{"ds":"数据源","sql":"修正后的完整SQL"}。',
        `原计划：${JSON.stringify({ ds: plan.ds, sql: plan.sql })}\n执行错误：${e.message}\n\n【可用映射（只允许用这里的库/表/列）】\n${ctx.phys}\n\n修正要求：以 SELECT 开头、PostgreSQL 方言（日期用 to_char/EXTRACT）、末尾 LIMIT≤100、只改 SQL 不改语义。`);
      const fixed = parseJsonLoose(fixLlm);
      if (fixed?.sql && fixed?.ds) {
        const { safeSql, rows, tables } = await executeQueryPlan({ ds: fixed.ds, sql: fixed.sql });
        const masked = maskPatientRows(rows);
        const answer = templateAnswer(q, rows);
        const matchedConcepts = await matchConcepts(q);
        const traceId = await persistQaTrace('ANALYTICS', q, { ...plan, sql: safeSql, usedTables: tables.join(','), semantics: (plan.semantics || '') + '（一次 SQL 修复后执行）' }, rows, answer, 'TEMPLATE', Date.now() - planned.started, { matchedConcepts });
        return {
          intent: 'SEMANTIC_QUERY', router: 'SEMANTIC', mode: 'QUERY', answer,
          parse: { semantics: plan.semantics, sql: safeSql, ds: plan.ds, rows: masked.slice(0, 20), rowCount: rows.length, matchedConcepts },
          traceId, links: [{ label: '证据链', route: `/trace?type=QA&key=${traceId}` }],
        };
      }
    } catch { /* 修复失败走下方兜底 */ }
    // 诚实兜底：现场 SQL 失败，但问题恰是某口径卡所指 → 回落口径卡实测（router=RULE）
    const cards = (await prefilterMetricCards(q)).filter(m => q.includes(m.name.slice(0, Math.max(2, m.name.length - 1))));
    if (cards.length) {
      const a = await metricCardAnswer(cards[0], 'ANALYTICS');
      const traceId = await persistQaTrace('ANALYTICS', q, { mode: 'GLOSSARY' }, null, a.answer, 'TEMPLATE', Date.now() - planned.started);
      return { ...a, router: 'RULE', ruleFallback: true, traceId };
    }
    recordMiss(q.trim().slice(0, 64), 'QUESTION', 'QA_ASK');
    return {
      intent: 'SEMANTIC_QUERY', router: 'SEMANTIC', mode: 'QUERY', unanswered: true,
      answer: `查询未执行：${e.message}。已回流概念缺口，请到语义映射补齐后重试。`,
      traceId: null, links: [{ label: '数据源绑定', route: '/datasource' }],
    };
  }
}
function templateAnswer(q, rows) {
  if (!rows || !rows.length) return '查询执行成功：0 条结果。';
  const keys = Object.keys(rows[0]);
  const nums = keys.filter(k => typeof rows[0][k] === 'number');
  if (keys.length === 1 && nums.length === 1) return `查询结果：${rows[0][keys[0]]}${/多少|数|笔|人|量/.test(q) ? '' : ''}（共 1 行）。`;
  return `查询返回 ${rows.length} 行${nums.length ? `，${nums.map(k => `${k} 合计 ${rows.reduce((s, r) => s + (Number(r[k]) || 0), 0)}`).join('，')}` : ''}。`;
}
async function matchConcepts(q) {
  const rows = await platform.prepare("SELECT code, name FROM bm_concept WHERE status='PUBLISHED'").all();
  return rows
    .filter(c => (c.name.length >= 2 && q.includes(c.name)) || q.toUpperCase().includes(c.code))
    .slice(0, 6).map(c => c.code);
}

// ============================================================
// CS ask 主入口
// ============================================================
async function csAsk(q) {
  // FEE 直答（投诉诊断类）
  const feeProbe = await platform.prepare("SELECT COUNT(*) c FROM bm_cs_feedback").get();
  void feeProbe;
  const recon = await platform.prepare('SELECT COUNT(*) c FROM link_node WHERE node_type=?').get('TICKET');
  void recon;
  const { intent, router } = await routeAsk(q, 'CS');
  if (!intent) return capabilityMenu(q);
  if (intent === 'FEE') return await feeAnswer();
  if (intent === 'DISPENSE_PAY') {
    const r = await reconcileDispensePay();
    const tiers = r.tiers.filter(t => t.count > 0).map(t => `${t.stateCode}:${t.count}笔（${t.severity}）`).join('；') || '无差异';
    return {
      intent, router,
      answer: `已执行三库实时核对（药房×收费×HIS）。${r.abnormalCount} 笔异常差异。分档：${tiers}。`,
      evidence: [['核对批次', r.runId], ['异常差异', `${r.abnormalCount} 笔`]],
      reconRunId: r.runId,
      links: [{ label: '查看差异明细', route: `/cs?recon=${r.runId}` }],
    };
  }
  if (intent === 'DISPENSE_SPLIT') return await dispenseSplitAnswer();
  if (intent === 'DISPENSE_RETURN') return await dispenseReturnAnswer();
  if (intent === 'MATERIAL') return await materialAnswer();
  if (intent === 'STAFF') return await staffAnswer(q);
  if (intent === 'GLOSSARY') {
    const g = await glossaryAnswer(q, 'CS');
    if (g) return g;
    return { ...capabilityMenu(q), answer: '口径库暂未收录该说法（已回流概念缺口）。' + capabilityMenu(q).answer };
  }
  if (intent === 'DOC_QA') return await docQaAnswer(q);
  if (intent === 'SEMANTIC_QUERY') {
    // 先试语义问数，失败落结构推理
    const a = await analyticsAsk(q);
    if (a.mode === 'QUERY' || a.metricCards || a.mode === 'MODEL_ANSWER') return { ...a, intent, router: 'SEMANTIC' };
    return await semanticModelAnswer(q);
  }
  return capabilityMenu(q);
}

R.post('/ask', async (req, res) => {
  const { question, scene = 'CS' } = req.body || {};
  if (!question || !question.trim()) throw new BizException('问题不能为空');
  const q = question.trim();
  const result = scene === 'ANALYTICS' ? await analyticsAsk(q) : await csAsk(q);
  res.json(ok(result));
});

// ============================================================
// 澄清任务
// ============================================================
R.post('/clarify/:id/answer', async (req, res) => {
  const task = await platform.prepare('SELECT * FROM bm_clarify_task WHERE id=?').get(req.params.id);
  if (!task) throw new BizException('澄清任务不存在');
  if (task.status !== 'PENDING') throw new BizException('任务已关闭');
  const supplement = String(req.body?.supplement || '').trim();
  if (!supplement) throw new BizException('补充内容不能为空');
  if (task.supplement && task.supplement.includes(supplement)) throw new BizException('补充内容重复提交');
  if ((task.supplement ? task.supplement.length + supplement.length : supplement.length) > 1024) throw new BizException('累计补充超过 1024 字');
  const newSupplement = task.supplement ? `${task.supplement}；${supplement}` : supplement;
  const qp = `${task.origin_question}（${newSupplement}）`;
  await platform.prepare('UPDATE bm_clarify_task SET supplement=?, rounds=rounds+1 WHERE id=?').run(newSupplement, task.id);
  // 重入同一路由
  const scene = task.scene === 'ANALYTICS' ? 'ANALYTICS' : 'CS';
  const result = scene === 'ANALYTICS' ? await analyticsAsk(qp) : await csAsk(qp);
  const stillUnclear = result.clarify || result.unanswered;
  if (!stillUnclear) {
    await platform.prepare("UPDATE bm_clarify_task SET status='RESOLVED', answered_at=?, closed_at=? WHERE id=?").run(now(), now(), task.id);
    result.clarifyResolved = true;
  } else {
    const rounds = task.rounds + 1;
    if (rounds >= 2) {
      const miss = recordMiss(qp.slice(0, 64), 'QUESTION', scene === 'ANALYTICS' ? 'QA_ASK' : 'CS_ASK');
      await platform.prepare("UPDATE bm_clarify_task SET status='GAVE_UP', miss_id=?, closed_at=? WHERE id=?").run(miss?.id || null, now(), task.id);
      result.gaveUp = true;
      result.answer = '两轮澄清仍未命中，已回流本体增长回路（概念缺口）。' + (result.answer || '');
    } else {
      result.clarify = { id: task.id, clarifyQuestion: result.clarify?.clarifyQuestion || '请再补充一些信息（时间范围/科室/对象/口径）。', rounds };
      await platform.prepare('UPDATE bm_clarify_task SET rounds=? WHERE id=?').run(rounds, task.id);
    }
  }
  res.json(ok(result));
});
R.get('/clarify/list', async (req, res) => {
  const rows = await platform.prepare("SELECT * FROM bm_clarify_task ORDER BY CASE status WHEN 'PENDING' THEN 0 WHEN 'GAVE_UP' THEN 1 ELSE 2 END, id DESC").all();
  res.json(ok(rows));
});

// 路由评议
R.post('/feedback', async (req, res) => {
  const { question, intent, router: rt, correct, comment } = req.body || {};
  if (!question) throw new BizException('问题不能为空');
  await platform.prepare('INSERT INTO bm_cs_feedback(question,intent,router,correct,comment) VALUES (?,?,?,?,?)')
    .run(question, intent || null, rt || null, correct ? 1 : 0, comment || null);
  res.json(ok(true));
});
R.get('/feedback/list', async (req, res) => {
  const pageNum = Math.max(1, parseInt(req.query.pageNum || '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize || '20', 10)));
  const totalRow = await platform.prepare('SELECT COUNT(*) c FROM bm_cs_feedback').get();
  const list = await platform.prepare('SELECT * FROM bm_cs_feedback ORDER BY id DESC LIMIT ? OFFSET ?').all(pageSize, (pageNum - 1) * pageSize);
  res.json(ok({ list, total: totalRow.c, pageNum, pageSize }));
});

// ============================================================
// 工单诊断 / 一键处置
// ============================================================
R.get('/ticket/:id/diagnosis', async (req, res) => {
  const ticket = await platform.prepare('SELECT * FROM link_node WHERE id=?').get(req.params.id);
  if (!ticket) throw new BizException('工单不存在');
  const r = await runRca(ticket.ref_no);
  const rootCause = await enhanceRcaWithLlm(r.caseId);
  res.json(ok({ ...r, conclusion: rootCause || r.conclusion, llmUsed: !!rootCause }));
});
R.post('/ticket/:id/refund', async (req, res) => {
  const ticket = await platform.prepare('SELECT * FROM link_node WHERE id=?').get(req.params.id);
  if (!ticket) throw new BizException('工单不存在');
  const operator = req.query.operator || '客服';
  let payload = {};
  try { payload = JSON.parse(ticket.payload || '{}'); } catch { /* */ }
  const inhos = payload.inhos_no;
  if (!inhos) throw new BizException('工单缺少住院号，无法生成退费申请');
  const charge = await businessDb('DS_CHARGE');
  const his = await businessDb('DS_HIS');
  const rows = await his.prepare(`SELECT f.fee_id, f.amount FROM fee_detail f JOIN medical_order o ON f.order_id=o.order_id
    WHERE o.order_status='2' AND f.fee_status='1' AND f.inhos_no=?`).all(inhos);
  if (!rows.length) throw new BizException('该患者无「取消未退费」费用');
  const refunds = [];
  for (const r of rows) {
    const exist = await charge.prepare('SELECT refund_id FROM refund_apply WHERE fee_id=?').get(r.fee_id);
    if (exist) { refunds.push({ refundId: exist.refund_id, feeId: r.fee_id, reused: true }); continue; }
    const refundId = `RA${now().replace(/[-: ]/g, '')}${String(Math.floor(Math.random() * 900) + 100)}`;
    await charge.prepare('INSERT INTO refund_apply(refund_id,inhos_no,fee_id,amount,reason,apply_time,status) VALUES (?,?,?,?,?,?,?)')
      .run(refundId, inhos, r.fee_id, r.amount, `客服工单 ${ticket.ref_no} 处置`, now(), '1');
    refunds.push({ refundId, feeId: r.fee_id, amount: r.amount });
  }
  // 处置单 + 工单办结（ref_no 唯一，加随机后缀防止同秒批量处置撞约束）
  const disId = `DIS${now().replace(/[-: ]/g, '')}${Math.random().toString(36).slice(2, 6)}`;
  await platform.prepare('INSERT INTO link_node(node_type,ref_no,title,concept_code,status,occurred_at,payload) VALUES (?,?,?,?,?,?,?)')
    .run('DISPOSAL', disId, `退费处置单（${inhos}）`, ticket.concept_code, '已办结', now(), JSON.stringify({ refunds, operator }));
  await platform.prepare('INSERT INTO link_rel(from_ref_no,to_ref_no,rel_type,remark) VALUES (?,?,?,?) ON CONFLICT DO NOTHING')
    .run(ticket.ref_no, disId, 'CLOSED_BY', '一键处置生成');
  await platform.prepare("UPDATE link_node SET status='已处置' WHERE id=?").run(ticket.id);
  res.json(ok({ refunds, disposalRef: disId, refundCount: refunds.length, totalAmount: rows.reduce((s, r) => s + r.amount, 0) }));
});
R.get('/ticket/customer-reply/:id', async (req, res) => {
  const ticket = await platform.prepare('SELECT * FROM link_node WHERE id=?').get(req.params.id);
  if (!ticket) throw new BizException('工单不存在');
  const cases = await platform.prepare('SELECT * FROM rca_case WHERE ticket_ref=? ORDER BY id DESC LIMIT 1').get(ticket.ref_no);
  const rootCause = cases?.conclusion || '';
  const conceptBasis = await basisEntries(ticket.concept_code);
  const llm = await chat('CS_REPLY', '你是医院客服主管。基于根因结论给客户写一段致歉与解释回复，专业诚恳，150字以内。',
    `工单：${ticket.title}\n根因：${rootCause}\n整改依据条目：${conceptBasis.map(b => b.title).join('、') || '无'}`);
  const reply = llm || `您好，经排查：${rootCause} 我们已启动存量费用补偿退费，并将字典一致性纳入每日巡检防止再次发生。给您带来不便深表歉意。${conceptBasis.length ? `（整改依据条目：${conceptBasis.map(b => b.title).join('、')}）` : ''}`;
  res.json(ok({ reply, llmUsed: !!llm, basis: conceptBasis.map(b => b.code) }));
});

// 跨库核对差异查询
R.get('/recon/diffs', async (req, res) => {
  const { runId } = req.query;
  const rows = runId
    ? await platform.prepare('SELECT * FROM bm_recon_diff WHERE run_id=? ORDER BY id').all(runId)
    : await platform.prepare('SELECT * FROM bm_recon_diff WHERE run_id=(SELECT run_id FROM bm_recon_diff ORDER BY id DESC LIMIT 1) ORDER BY id').all();
  res.json(ok(rows));
});

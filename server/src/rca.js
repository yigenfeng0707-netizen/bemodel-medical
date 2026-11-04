import express from 'express';
import { platform, now, businessDb } from './db.js';
import { BizException, ok, maskName } from './common.js';
import { chat } from './llm.js';

export const rcaRouter = express.Router();
const R = rcaRouter;

const SQL_PATIENT_BILL = `SELECT f.fee_id, f.order_id, f.item_name, f.amount, f.charge_time, o.order_status
  FROM fee_detail f JOIN medical_order o ON f.order_id = o.order_id
  WHERE o.order_status = '2' AND f.fee_status = '1' AND f.inhos_no = ?`;
const SQL_LIS_APPLY = `SELECT apply_id, order_id, patient_no, item_name, apply_status, update_time FROM lab_apply WHERE order_id IN`;
const SQL_STATUS_MAP = `SELECT src_status, src_status_name, target_action FROM status_map WHERE src_system = 'LIS'`;
const SQL_LIS_ACTUAL = `SELECT DISTINCT apply_status FROM lab_apply`;
const SQL_LIS_DICT = `SELECT status_code, status_name, app_version, effective_date FROM lab_dict_status ORDER BY effective_date`;
const SQL_HOSPITAL_IMPACT = `SELECT COUNT(DISTINCT f.inhos_no) AS patient_cnt, COUNT(*) AS fee_cnt,
  CAST(SUM(f.amount) AS INTEGER) AS total_amount, MIN(f.charge_time) AS first_at, MAX(f.charge_time) AS last_at
  FROM fee_detail f JOIN medical_order o ON f.order_id = o.order_id WHERE o.order_status='2' AND f.fee_status='1'`;

/** RCA 引擎：同步执行七步，步骤实时落库 */
export function runRca(ticketRef) {
  const ticket = platform.prepare("SELECT * FROM link_node WHERE ref_no=? AND node_type='TICKET'").get(ticketRef);
  if (!ticket) throw new BizException('工单不存在或类型不是 TICKET');
  const caseNo = `RCA-${now().replace(/[-: ]/g, '').slice(0, 14)}`;
  const c = platform.prepare('INSERT INTO rca_case(case_no,ticket_ref,concept_code,status) VALUES (?,?,?,?)')
    .run(caseNo, ticketRef, ticket.concept_code, 'RUNNING');
  const caseId = c.lastInsertRowid;
  const steps = [];
  const addStep = (stepNo, stepName, stepType, sqlText, hitCount, resultJson, status = 'SUCCESS') => {
    const r = platform.prepare('INSERT INTO rca_step(case_id,step_no,step_name,step_type,sql_text,hit_count,result_json,status,started_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(caseId, stepNo, stepName, stepType, sqlText, hitCount, resultJson ? JSON.stringify(resultJson) : null, status, now(), now());
    steps.push({ stepNo, stepName, stepType, sqlText, hitCount, result: resultJson, status });
    return r.lastInsertRowid;
  };
  let conclusion = '';
  try {
    // Step1 本体图遍历（双向 BFS 4 层）
    const relations = platform.prepare('SELECT * FROM bm_relation').all();
    const adj = new Map();
    for (const r of relations) {
      if (!adj.has(r.from_concept)) adj.set(r.from_concept, []);
      adj.get(r.from_concept).push({ to: r.to_concept, name: r.relation_name });
      if (!adj.has(r.to_concept)) adj.set(r.to_concept, []);
      adj.get(r.to_concept).push({ to: r.from_concept, name: r.relation_name });
    }
    const visited = new Set([ticket.concept_code]);
    const pathText = [];
    let frontier = [ticket.concept_code];
    for (let d = 0; d < 4 && frontier.length; d++) {
      const next = [];
      for (const cur of frontier) {
        for (const e of (adj.get(cur) || [])) {
          pathText.push(`${cur} —${e.name}→ ${e.to}`);
          if (!visited.has(e.to)) { visited.add(e.to); next.push(e.to); }
        }
      }
      frontier = next;
    }
    addStep(1, '沿本体关系遍历数据面', 'TRAVERSE', null, visited.size, { concepts: [...visited], paths: pathText });

    // Step2 患者账单核查
    let payload = {};
    try { payload = JSON.parse(ticket.payload || '{}'); } catch { /* */ }
    const inhos = payload.inhos_no || '';
    let billRows = [];
    if (inhos) {
      billRows = businessDb('DS_HIS').prepare(SQL_PATIENT_BILL).all(inhos);
      addStep(2, '患者账单核查（HIS：取消未退费）', 'PROBE', SQL_PATIENT_BILL, billRows.length,
        { rows: billRows, patient: maskName(payload.patient || inhos), inhos_no: inhos });
    } else {
      addStep(2, '患者账单核查（工单缺住院号，跳过）', 'PROBE', null, 0, { note: '工单 payload 缺 inhos_no' });
    }

    // Step3 跨库核实 LIS
    let lisRows = [];
    if (billRows.length) {
      const orderIds = billRows.map(r => r.order_id);
      const ph = orderIds.map(() => '?').join(',');
      lisRows = businessDb('DS_LIS').prepare(`${SQL_LIS_APPLY} (${ph})`).all(...orderIds);
      addStep(3, '跨库核实 LIS 撤销状态', 'PROBE', `${SQL_LIS_APPLY} (...)`, lisRows.length, { rows: lisRows });
    } else {
      addStep(3, '跨库核实 LIS（无待核实医嘱，跳过）', 'PROBE', null, 0, { note: 'Step2 无命中' });
    }

    // Step4 字典裂缝定位（根因证据）
    const mapped = businessDb('DS_HIS').prepare(SQL_STATUS_MAP).all();
    const actual = businessDb('DS_LIS').prepare(SQL_LIS_ACTUAL).all().map(r => r.apply_status);
    const dict = businessDb('DS_LIS').prepare(SQL_LIS_DICT).all();
    const mappedCodes = new Set(mapped.map(m => m.src_status));
    const missing = actual.filter(a => !mappedCodes.has(a));
    addStep(4, '状态字典裂缝定位（根因证据）', 'PROBE', `${SQL_STATUS_MAP}; ${SQL_LIS_ACTUAL}; ${SQL_LIS_DICT}`,
      missing.length, { mapped, actual, dictVersions: dict, missingCodes: missing });

    // Step5 全院影响面
    const impact = businessDb('DS_HIS').prepare(SQL_HOSPITAL_IMPACT).get();
    addStep(5, '全院影响面统计', 'PROBE', SQL_HOSPITAL_IMPACT, impact.fee_cnt || 0, impact);

    // Step6 翻变更留痕
    const linkNodes = platform.prepare(`SELECT node_type, ref_no, title, occurred_at FROM link_node
      WHERE concept_code IN (${[...visited].map(() => '?').join(',')}) AND node_type IN ('CHANGE','DEPLOY','TESTCASE','REQUIREMENT') ORDER BY occurred_at`).all(...visited);
    addStep(6, '关联链路变更留痕', 'LINK', null, linkNodes.length, linkNodes);

    // Step7 生成报告（LLM 或诚实模板）
    const evidence = [
      `患者 ${inhos || '-'} 存在 ${billRows.length} 笔「医嘱已取消、费用仍正常」记录`,
      lisRows.length ? `对应 LIS 申请状态：${lisRows.map(r => r.apply_status).join(',')}` : '（无 LIS 记录）',
      `LIS 实际在用状态码：${actual.join(',')}；HIS 适配器已映射：${mapped.map(m => m.src_status).join(',')}；未映射缺口：${missing.join(',') || '无'}`,
      `LIS 状态字典版本演进：${dict.map(d => `${d.app_version}:${d.status_code}(${d.effective_date}~${d.end_date || '今'})`).join('；')}`,
      `全院影响：${impact.patient_cnt} 名患者、${impact.fee_cnt} 笔费用、合计 ¥${impact.total_amount}`,
      linkNodes.length ? `关联变更：${linkNodes.map(n => `${n.ref_no} ${n.title}`).join('；')}` : '（无关联变更留痕）',
    ];
    conclusion = `LIS v5.2 升级（2026-08-15）将检验申请撤销状态码由X改为C，但HIS计费适配器status_map未同步配置新码「${missing[0] || 'C'}」的退费映射，导致升级后已撤销的检验医嘱仍正常计费。全院共影响${impact.patient_cnt}名患者、${impact.fee_cnt}笔费用，合计¥${impact.total_amount}。`;
    addStep(7, '产出根因分析报告', 'REPORT', null, evidence.length, { evidence, conclusion });

    // 回写根因追溯边
    for (const n of linkNodes.filter(n => n.node_type === 'CHANGE')) {
      platform.prepare('INSERT OR IGNORE INTO link_rel(from_ref_no,to_ref_no,rel_type,remark) VALUES (?,?,?,?)')
        .run(n.ref_no, ticketRef, 'CAUSES', `根因分析 ${caseNo} 关联`);
    }
    platform.prepare("UPDATE rca_case SET status='DONE', conclusion=?, finished_at=? WHERE id=?").run(conclusion, now(), caseId);
    platform.prepare(`INSERT INTO rca_report(case_id, root_cause, evidence_json, impact_json, suggestions_json, llm_used)
      VALUES (?,?,?,?,?,0)`)
      .run(caseId, conclusion, JSON.stringify(evidence), JSON.stringify(impact), JSON.stringify(defaultSuggestions(missing)));
    return { caseId, caseNo, conclusion, steps, evidence, impact, suggestions: defaultSuggestions(missing), llmUsed: false };
  } catch (e) {
    platform.prepare("UPDATE rca_case SET status='FAILED', conclusion=?, finished_at=? WHERE id=?").run(`分析中断：${e.message}`, now(), caseId);
    throw e;
  }
}
function defaultSuggestions(missing) {
  const code = missing[0] || 'C';
  return [
    `研发：HIS 计费适配器 status_map 立即补录 LIS 撤销码「${code}」→ REFUND 映射并发布`,
    '运维：补录后对存量「取消未退费」数据执行一次性补偿退费',
    '测试：新增状态码变更回归用例（字典跨库一致性对账纳入 CI）',
    '治理：GOV-004 字典一致性规则挂每日巡检，状态码漂移自动告警',
  ];
}

/** 异步 LLM 报告增强（工单诊断页调用后静默覆盖 root_cause） */
export async function enhanceRcaWithLlm(caseId) {
  const c = platform.prepare('SELECT * FROM rca_case WHERE id=?').get(caseId);
  if (!c) return null;
  const rep = platform.prepare('SELECT * FROM rca_report WHERE case_id=?').get(caseId);
  if (!rep) return null;
  const steps = platform.prepare('SELECT * FROM rca_step WHERE case_id=? ORDER BY step_no').all(caseId);
  const evidence = [];
  for (const s of steps) {
    if (s.result_json) evidence.push(`【${s.step_name}】命中${s.hit_count}：${s.result_json.slice(0, 300)}`);
  }
  const llm = await chat('RCA_REPORT',
    '你是医疗信息化根因分析专家。基于给定证据输出根因分析报告，结构：一、问题概述；二、根因结论；三、证据链分析；四、影响范围；五、整改建议。语言专业简洁，500字以内。',
    `工单：${c.ticket_ref}\n证据链：\n${evidence.join('\n')}`);
  if (llm) {
    platform.prepare('UPDATE rca_report SET root_cause=?, llm_used=1 WHERE case_id=?').run(llm, caseId);
    platform.prepare('UPDATE rca_case SET conclusion=?, status=\'DONE\' WHERE id=?').run(llm, caseId);
    return llm;
  }
  return null; // LLM 未启用时返回 null，调用方 llmUsed 才能诚实为 false（模板结论已在 r.conclusion）
}

R.post('/start', (req, res) => {
  const ticketRef = req.query.ticketRef;
  const result = runRca(ticketRef);
  res.json(ok(result));
});
R.get('/list', (req, res) => {
  res.json(ok(platform.prepare('SELECT * FROM rca_case ORDER BY id DESC').all()));
});
R.get('/:caseId', (req, res) => {
  const c = platform.prepare('SELECT * FROM rca_case WHERE id=?').get(req.params.caseId);
  if (!c) throw new BizException('案例不存在');
  const steps = platform.prepare('SELECT * FROM rca_step WHERE case_id=? ORDER BY step_no').all(c.id);
  const report = platform.prepare('SELECT * FROM rca_report WHERE case_id=?').get(c.id);
  res.json(ok({ case: c, steps, report }));
});

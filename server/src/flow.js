import express from 'express';
import { platform, now, businessDb } from './db.js';
import { BizException, ok, maskName, maskPatientRow } from './common.js';
import { chat } from './llm.js';
import { currentTag } from './llm.js';

export const flowRouter = express.Router();
const F = flowRouter;
export const clinicalRouter = express.Router();
const C = clinicalRouter;

// ==================== 医嘱闭环（住院） ====================
F.get('/patients', (req, res) => {
  const { keyword = '', pageNum = 1, pageSize = 20 } = req.query;
  const his = businessDb('DS_HIS');
  const where = keyword ? "WHERE patient_name LIKE ? OR inhos_no LIKE ?" : '';
  const params = keyword ? [`%${keyword}%`, `%${keyword}%`] : [];
  const total = his.prepare(`SELECT COUNT(*) c FROM inpatient ${where}`).get(...params).c;
  const rows = his.prepare(`SELECT * FROM inpatient ${where} ORDER BY admit_time DESC LIMIT ? OFFSET ?`)
    .all(...params, Number(pageSize), (Number(pageNum) - 1) * Number(pageSize));
  const list = rows.map(r => {
    const orderCnt = his.prepare('SELECT COUNT(*) c FROM medical_order WHERE inhos_no=?').get(r.inhos_no).c;
    const feeSum = his.prepare('SELECT CAST(COALESCE(SUM(amount),0) AS INTEGER) s FROM fee_detail WHERE inhos_no=?').get(r.inhos_no).s;
    return { ...r, patient_name: maskName(r.patient_name), orderCount: orderCnt, feeTotal: feeSum };
  });
  res.json(ok({ list, total, pageNum: Number(pageNum), pageSize: Number(pageSize) }));
});

F.get('/loop/:inhosNo', (req, res) => {
  const inhos = req.params.inhosNo;
  const his = businessDb('DS_HIS'), lis = businessDb('DS_LIS'), charge = businessDb('DS_CHARGE');
  const ph = businessDb('DS_PHARMACY'), pacs = businessDb('DS_PACS'), nurse = businessDb('DS_NURSE');
  const patient = his.prepare('SELECT * FROM inpatient WHERE inhos_no=?').get(inhos);
  if (!patient) throw new BizException('住院号不存在');
  const orders = his.prepare('SELECT * FROM medical_order WHERE inhos_no=? ORDER BY create_time').all(inhos);
  const fees = his.prepare('SELECT * FROM fee_detail WHERE inhos_no=?').all(inhos);
  const feeByOrder = new Map(fees.map(f => [f.order_id, f]));
  const ordersOut = orders.map(o => {
    const fee = feeByOrder.get(o.order_id);
    let execInfo = null, loopStatus = 'PENDING';
    if (o.order_status === '2') {
      loopStatus = fee && fee.fee_status === '2' ? 'CLOSED_CANCELED' : 'BROKEN';
    } else if (o.order_status === '0') {
      loopStatus = 'PENDING';
    } else {
      if (o.order_type === '检验') {
        const apply = lis.prepare('SELECT * FROM lab_apply WHERE order_id=?').get(o.order_id);
        const report = apply ? lis.prepare('SELECT * FROM lab_report WHERE apply_id=?').get(apply.apply_id) : null;
        execInfo = { applyStatus: apply?.apply_status, reportStatus: report?.result_status, reporter: report?.reporter };
      } else if (o.order_type === '检查') {
        const rep = pacs.prepare('SELECT * FROM exam_report WHERE order_id=?').get(o.order_id);
        execInfo = { abnormalFlag: rep?.abnormal_flag, conclusion: rep?.conclusion, reviewer: rep?.reviewer };
      } else if (o.order_type === '药品') {
        const disp = ph.prepare('SELECT * FROM dispense_record WHERE order_id=?').get(o.order_id);
        const review = ph.prepare('SELECT * FROM presc_review WHERE order_id=?').get(o.order_id);
        execInfo = { dispenseStatus: disp?.status, pharmacist: disp?.pharmacist, reviewResult: review?.review_result, rejectReason: review?.reject_reason, reviewTime: review?.review_time, pharmacist2: review?.pharmacist };
      }
      const nurseExec = nurse.prepare('SELECT * FROM nurse_exec WHERE order_id=?').get(o.order_id);
      if (nurseExec) execInfo = { ...(execInfo || {}), nurseExec: nurseExec.exec_type, nurse: nurseExec.nurse, execStatus: nurseExec.exec_status };
      const executed = (o.order_type === '检验' && execInfo?.reportStatus) || (o.order_type === '检查' && execInfo?.conclusion) || (o.order_type === '药品' && execInfo?.dispenseStatus === '1') || !!execInfo?.nurseExec;
      loopStatus = executed && fee ? 'CLOSED' : 'PENDING';
    }
    return {
      orderId: o.order_id, itemName: o.item_name, orderType: o.order_type, doctor: o.doctor,
      createTime: o.create_time, orderStatus: o.order_status,
      fee: fee ? { amount: fee.amount, feeStatus: fee.fee_status, chargeTime: fee.charge_time } : null,
      execInfo, loopStatus,
    };
  });
  const payments = charge.prepare('SELECT * FROM pay_record WHERE inhos_no=? ORDER BY pay_time').all(inhos);
  const payTypeName = { '1': '预交金', '2': '结算补缴', '3': '退费', '4': '门诊缴费' };
  const settlements = charge.prepare('SELECT * FROM settlement WHERE inhos_no=?').all(inhos);
  const invoices = settlements.length ? charge.prepare(`SELECT * FROM invoice WHERE settle_id IN (${settlements.map(() => '?').join(',')})`).all(...settlements.map(s => s.settle_id)) : [];
  // 全流程时间线
  const events = [];
  events.push({ at: patient.admit_time, system: 'HIS', name: '入院登记', detail: `${patient.dept} ${patient.ward} 主管：${patient.doctor}` });
  for (const o of orders) {
    events.push({ at: o.create_time, system: 'HIS', name: `开立医嘱：${o.item_name}`, detail: `医生 ${o.doctor}` });
    if (o.cancel_time) events.push({ at: o.cancel_time, system: 'HIS', name: `取消医嘱：${o.item_name}`, detail: '' });
    const apply = lis.prepare('SELECT * FROM lab_apply WHERE order_id=?').get(o.order_id);
    if (apply) {
      events.push({ at: apply.apply_time, system: 'LIS', name: `检验申请：${o.item_name}`, detail: `状态 ${apply.apply_status}` });
      const rep = lis.prepare('SELECT * FROM lab_report WHERE apply_id=?').get(apply.apply_id);
      if (rep) events.push({ at: rep.report_time, system: 'LIS', name: `检验报告：${o.item_name}`, detail: `结果 ${rep.result_status === 'A' ? '异常' : '正常'}（${rep.reporter}）` });
    }
    const exam = pacs.prepare('SELECT * FROM exam_report WHERE order_id=?').get(o.order_id);
    if (exam) events.push({ at: exam.report_time, system: 'PACS', name: `检查报告：${o.item_name}`, detail: `${exam.abnormal_flag === 'Y' ? '异常' : '正常'}（${exam.reviewer}）` });
    const disp = ph.prepare('SELECT * FROM dispense_record WHERE order_id=?').get(o.order_id);
    if (disp) events.push({ at: disp.dispense_time, system: '药房', name: `调剂发药：${o.item_name}`, detail: `药师 ${disp.pharmacist}` });
    const review = ph.prepare('SELECT * FROM presc_review WHERE order_id=?').get(o.order_id);
    if (review) events.push({ at: review.review_time, system: '药房', name: `处方审核：${review.review_result}`, detail: review.reject_reason || review.pharmacist });
    const ne = nurse.prepare('SELECT * FROM nurse_exec WHERE order_id=?').get(o.order_id);
    if (ne) events.push({ at: ne.exec_time, system: '护士站', name: `护士执行：${ne.exec_type}`, detail: ne.nurse });
    const fee = feeByOrder.get(o.order_id);
    if (fee) events.push({ at: fee.charge_time, system: '收费', name: `计费：${o.item_name} ¥${fee.amount}`, detail: fee.fee_status === '2' ? '已退费' : '正常计费' });
  }
  for (const p of payments) events.push({ at: p.pay_time, system: '收费', name: `缴费：${payTypeName[p.pay_type] || p.pay_type} ¥${p.amount}`, detail: `${p.channel}（${p.operator}）` });
  for (const s of settlements) {
    events.push({ at: s.settle_time, system: '收费', name: `出院结算 ¥${s.total_amount}`, detail: `结算单 ${s.settle_id}` });
    const inv = invoices.find(i => i.settle_id === s.settle_id);
    if (inv) events.push({ at: inv.invoice_time, system: '收费', name: `开票 ¥${inv.amount}`, detail: inv.invoice_id });
  }
  if (patient.discharge_time) events.push({ at: patient.discharge_time, system: 'HIS', name: '出院', detail: '' });
  events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  res.json(ok({
    patient: { ...patient, patient_name: maskName(patient.patient_name) },
    orders: ordersOut,
    payments: payments.map(p => ({ ...p, payTypeName: payTypeName[p.pay_type] || p.pay_type })),
    settlements, invoices,
    feeTotal: fees.reduce((s, f) => s + (f.fee_status === '1' ? f.amount : 0), 0),
    paidTotal: payments.reduce((s, p) => s + (p.pay_type === '3' ? -p.amount : p.amount), 0),
    settleTotal: settlements.reduce((s, x) => s + x.total_amount, 0),
    timeline: events,
  }));
});

// ==================== 门诊 ====================
F.get('/opd/patients', (req, res) => {
  const opd = businessDb('DS_OPD');
  const regs = opd.prepare('SELECT * FROM opd_reg ORDER BY reg_time DESC').all();
  const list = regs.map(r => {
    const prescs = opd.prepare('SELECT * FROM opd_presc WHERE card_no=?').all(r.pat_card_no);
    const visit = opd.prepare('SELECT * FROM opd_visit WHERE card_no=?').get(r.pat_card_no);
    return {
      ...r, pat_name: maskName(r.pat_name),
      prescCount: prescs.length,
      execTotal: prescs.filter(p => p.presc_status === '3').reduce((s, p) => s + p.price * p.quantity, 0),
      visit,
    };
  });
  res.json(ok(list));
});
F.get('/opd/loop/:cardNo', (req, res) => {
  const opd = businessDb('DS_OPD');
  const reg = opd.prepare('SELECT * FROM opd_reg WHERE pat_card_no=?').get(req.params.cardNo);
  if (!reg) throw new BizException('就诊卡号不存在');
  const visit = opd.prepare('SELECT * FROM opd_visit WHERE card_no=?').get(req.params.cardNo);
  const prescs = opd.prepare('SELECT * FROM opd_presc WHERE card_no=? ORDER BY create_time').all(req.params.cardNo);
  const prescOut = prescs.map(p => {
    let loopStatus = 'UNPAID';
    if (p.presc_status === '0') loopStatus = 'CLOSED_CANCELED';
    else if (p.presc_status === '3') loopStatus = 'CLOSED';
    else if (p.presc_status === '2') loopStatus = 'PENDING';
    else if (p.presc_status === '1') loopStatus = 'UNPAID';
    return { ...p, loopStatus };
  });
  const timeline = [];
  timeline.push({ at: reg.reg_time, system: '门诊', name: `挂号（${reg.reg_dept}）`, detail: reg.reg_status === '2' ? '已退号' : `挂号费 ¥${reg.reg_fee}` });
  if (visit) timeline.push({ at: visit.visit_time, system: '门诊', name: `看诊：${visit.diag}`, detail: visit.doctor });
  for (const p of prescs) timeline.push({ at: p.create_time, system: '门诊', name: `处方：${p.item_name}`, detail: `状态 ${p.presc_status} ¥${p.price * p.quantity}` });
  timeline.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  res.json(ok({ reg: { ...reg, pat_name: maskName(reg.pat_name) }, visit, prescs: prescOut, timeline }));
});

// ==================== 人员下钻 ====================
F.get('/staff', (req, res) => {
  const name = (req.query.name || '').replace(/医生|护士|药师|主任|副主任/g, '');
  const his = businessDb('DS_HIS');
  const staff = his.prepare('SELECT * FROM staff WHERE staff_name LIKE ?').all(`%${name}%`);
  if (!staff.length) return res.json(ok({ found: false }));
  const s = staff[0];
  const dept = his.prepare('SELECT * FROM dept WHERE dept_code=?').get(s.dept_code);
  const footprint = {};
  const dispenses = businessDb('DS_PHARMACY').prepare('SELECT COUNT(*) c FROM dispense_record WHERE pharmacist=?').get(s.staff_name).c;
  if (dispenses) footprint['调剂发药'] = `${dispenses} 次`;
  const reviews = businessDb('DS_PHARMACY').prepare('SELECT COUNT(*) c FROM presc_review WHERE pharmacist=?').get(s.staff_name).c;
  if (reviews) footprint['处方审核'] = `${reviews} 次`;
  const nurses = businessDb('DS_NURSE').prepare('SELECT COUNT(*) c FROM nurse_exec WHERE nurse=?').get(s.staff_name).c;
  if (nurses) footprint['护理执行'] = `${nurses} 次`;
  const reports = businessDb('DS_LIS').prepare('SELECT COUNT(*) c FROM lab_report WHERE reporter=?').get(s.staff_name).c;
  if (reports) footprint['检验报告'] = `${reports} 份`;
  const pacsR = businessDb('DS_PACS').prepare('SELECT COUNT(*) c FROM exam_report WHERE reviewer=?').get(s.staff_name).c;
  if (pacsR) footprint['检查审核'] = `${pacsR} 份`;
  const orders = his.prepare('SELECT COUNT(*) c FROM medical_order WHERE doctor=?').get(s.staff_name).c;
  if (orders) footprint['开立医嘱'] = `${orders} 条`;
  const colleagues = dept ? his.prepare('SELECT staff_name, role, title FROM staff WHERE dept_code=? AND staff_id<>?').all(s.dept_code, s.staff_id) : [];
  res.json(ok({
    found: true, staff: s, dept, footprint, colleagues,
    covered: Object.keys(footprint).length > 0 || ['医生', '护士', '药师'].includes(s.role),
  }));
});

// ==================== 病案内涵质控（八类规则引擎，双引擎互证） ====================
const QC_RULES = () => platform.prepare("SELECT * FROM bm_rule WHERE engine='QC' AND status='PUBLISHED'").all();
function qcCheckRecord(record) {
  const his = businessDb('DS_HIS'), lis = businessDb('DS_LIS'), pacs = businessDb('DS_PACS');
  const emr = businessDb('DS_EMR'), ph = businessDb('DS_PHARMACY');
  const findings = [];
  const rules = QC_RULES();
  const patient = his.prepare('SELECT * FROM inpatient WHERE inhos_no=?').get(record.inhos_no);
  const diagList = String(record.diag_list || record.diag_main || '');
  const orders = his.prepare("SELECT * FROM medical_order WHERE inhos_no=?").all(record.inhos_no);
  const labs = orders.filter(o => o.order_type === '检验');
  const drugs = orders.filter(o => o.order_type === '药品');
  const exams = orders.filter(o => o.order_type === '检查');
  const surg = emr.prepare('SELECT * FROM emr_surgery WHERE inhos_no=?').all(record.inhos_no);
  for (const rule of rules) {
    let expr; try { expr = JSON.parse(rule.expr_json || '{}'); } catch { continue; }
    let hit = false, evidence = '';
    switch (expr.type) {
      case 'DIAG_REQUIRES_ITEM': {
        const kw = (expr.diagKeywords || []).find(k => diagList.includes(k));
        if (!kw) continue;
        const hasItem = [...labs, ...exams].some(o => (expr.itemCodes || []).includes(o.item_code));
        hit = !hasItem;
        evidence = hit ? `主要诊断含「${kw}」，但无配套检验/检查（需 ${expr.itemCodes.join('/')})` : `诊断「${kw}」有配套医嘱`;
        break;
      }
      case 'PREOP_REQUIRES': {
        if (!surg.length) continue;
        const hasCoag = labs.some(o => (expr.itemCodes || []).includes(o.item_code) && o.order_status !== '2');
        hit = !hasCoag;
        evidence = hit ? `存在手术记录（${surg.map(s => s.proc_name).join('、')}），术前缺 ${expr.itemCodes.join('/')} 检验` : '术前检查齐全';
        break;
      }
      case 'ABNORMAL_REQUIRES_COVER': {
        for (const o of labs) {
          const apply = lis.prepare('SELECT * FROM lab_apply WHERE order_id=?').get(o.order_id);
          const rep = apply ? lis.prepare('SELECT * FROM lab_report WHERE apply_id=?').get(apply.apply_id) : null;
          if (rep && rep.result_status === 'A' && (expr.itemCodes || []).includes(o.item_code)) {
            const covered = drugs.some(d => (expr.drugCodes || []).includes(d.item_code) && String(d.create_time) > String(rep.report_time));
            if (!covered) { hit = true; evidence = `${o.item_name} 报告异常（${rep.report_time}）之后无后续处置用药（需 ${expr.drugCodes.join('/')})`; }
          }
        }
        if (!hit) continue;
        break;
      }
      case 'COMPLICATION_REQUIRES_ITEM': {
        const complications = diagList.split(',').slice(1);
        const kw = complications.find(d => (expr.complicationKeywords || []).some(k => (DIAG_NAME(d) || d).includes(k)));
        if (!kw) continue;
        const covered = drugs.some(d => (expr.drugCodes || []).includes(d.item_code));
        hit = !covered;
        evidence = hit ? `并发症「${DIAG_NAME(kw) || kw}」无对应治疗用药（需 ${expr.drugCodes.join('/')})` : '并发症有处置用药';
        break;
      }
      case 'SEX_DISJOINT_DIAG': {
        if (!patient || patient.sex !== '男') continue;
        const kw = diagList.split(',').find(d => (expr.femaleDiagKeywords || []).some(k => (DIAG_NAME(d) || d).includes(k)));
        if (!kw) continue;
        hit = true;
        evidence = `男性患者出现诊断「${DIAG_NAME(kw) || kw}」，违反公理 AX-003（性别互斥）`;
        break;
      }
      case 'EXAM_ABNORMAL_REQUIRES_COVER': {
        for (const o of exams) {
          const rep = pacs.prepare('SELECT * FROM exam_report WHERE order_id=?').get(o.order_id);
          if (rep && rep.abnormal_flag === 'Y') {
            const covered = drugs.some(d => (expr.drugCodes || []).includes(d.item_code) && String(d.create_time) > String(rep.report_time));
            if (!covered) { hit = true; evidence = `检查「${o.item_name}」报告异常（${rep.report_time}）后无后续处置用药`; }
          }
        }
        if (!hit) continue;
        break;
      }
      default: continue;
    }
    if (hit) findings.push({ ruleCode: rule.rule_code, ruleName: rule.name, severity: rule.severity, evidence, exprType: expr.type, axiom: expr.type === 'SEX_DISJOINT_DIAG' ? 'AX-003' : null, dataSources: ['DS_HIS', 'DS_LIS', 'DS_PACS', 'DS_EMR'].slice(0, 3) });
  }
  return findings;
}
function DIAG_NAME(code) {
  if (!/^\w+$/.test(String(code))) return null;
  const d = businessDb('DS_EMR').prepare('SELECT diag_name FROM diag_dict WHERE diag_code=?').get(code);
  return d?.diag_name || null;
}
C.get('/qc/records', (req, res) => {
  const { keyword = '' } = req.query;
  const emr = businessDb('DS_EMR');
  const rows = emr.prepare('SELECT * FROM emr_record ORDER BY record_id').all()
    .filter(r => !keyword || r.patient_name.includes(keyword) || r.inhos_no.includes(keyword) || (r.diag_main || '').includes(keyword));
  const out = rows.map(r => {
    const last = platform.prepare('SELECT * FROM qc_result WHERE record_id=? ORDER BY id DESC LIMIT 1').get(r.record_id);
    return { ...maskPatientRow(r), qcStatus: last ? (last.pass_flag ? '通过' : '不通过') : (r.qc_status || '未质控') };
  });
  res.json(ok(out));
});
C.post('/qc/check/:recordId', async (req, res) => {
  const emr = businessDb('DS_EMR');
  const record = emr.prepare('SELECT * FROM emr_record WHERE record_id=?').get(req.params.recordId);
  if (!record) throw new BizException('病案不存在');
  const findings = qcCheckRecord(record);
  const pass = findings.length === 0;
  const trace = { ontologyVersion: currentTag(), rules: findings.map(f => f.ruleCode), axioms: findings.map(f => f.axiom).filter(Boolean), concepts: ['EMR_RECORD', 'DIAGNOSIS', 'LAB_REPORT'] };
  const llm = await chat('QC_REVIEW', '你是病案质控专家。基于质控发现输出：总体结论、风险解读、整改建议。300字以内。',
    `病案：${record.record_id}（${maskName(record.patient_name)}）主诊断 ${record.diag_main}\n质控发现：${findings.map(f => `[${f.ruleCode}] ${f.evidence}`).join('；') || '无（全部规则通过）'}`);
  platform.prepare('INSERT INTO qc_result(record_id,inhos_no,record_type,pass_flag,findings_json,trace_json,llm_used,llm_summary) VALUES (?,?,?,?,?,?,?,?)')
    .run(record.record_id, record.inhos_no, record.record_type, pass ? 1 : 0, JSON.stringify(findings), JSON.stringify(trace), llm ? 1 : 0, llm || null);
  emr.prepare('UPDATE emr_record SET qc_status=? WHERE record_id=?').run(pass ? '通过' : '不通过', record.record_id);
  res.json(ok({ recordId: record.record_id, pass, findings, trace, llmSummary: llm || (pass ? '病案内涵质控通过，全部规则无命中。' : `共 ${findings.length} 项质控发现，详见清单。`), llmUsed: !!llm }));
});
C.post('/qc/check-all', async (req, res) => {
  const emr = businessDb('DS_EMR');
  const records = emr.prepare('SELECT * FROM emr_record ORDER BY record_id').all();
  let passCnt = 0;
  for (const record of records) {
    const findings = qcCheckRecord(record);
    const pass = findings.length === 0;
    if (pass) passCnt++;
    const trace = { ontologyVersion: currentTag(), rules: findings.map(f => f.ruleCode), axioms: findings.map(f => f.axiom).filter(Boolean), concepts: ['EMR_RECORD'] };
    platform.prepare('INSERT INTO qc_result(record_id,inhos_no,record_type,pass_flag,findings_json,trace_json,llm_used,llm_summary) VALUES (?,?,?,?,?,?,0,?)')
      .run(record.record_id, record.inhos_no, record.record_type, pass ? 1 : 0, JSON.stringify(findings), JSON.stringify(trace), pass ? '通过' : `${findings.length} 项发现（规则模板）`);
    emr.prepare('UPDATE emr_record SET qc_status=? WHERE record_id=?').run(pass ? '通过' : '不通过', record.record_id);
  }
  res.json(ok({ total: records.length, pass: passCnt, fail: records.length - passCnt }));
});
C.get('/qc/result/:recordId', (req, res) => {
  const r = platform.prepare('SELECT * FROM qc_result WHERE record_id=? ORDER BY id DESC LIMIT 1').get(req.params.recordId);
  res.json(ok(r || null));
});

// ==================== 危重症预警 ====================
C.post('/alert/detect', (req, res) => {
  const lis = businessDb('DS_LIS');
  const abnormal = lis.prepare(`SELECT r.report_id, r.apply_id, a.patient_no, a.item_name, r.report_time
    FROM lab_report r JOIN lab_apply a ON a.apply_id=r.apply_id WHERE r.result_status='A'`).all();
  let created = 0, disposed = 0;
  for (const r of abnormal) {
    const refNo = `ALERT-LR${String(r.report_time || '').replace(/[-: ]/g, '').slice(0, 14)}`;
    const exist = platform.prepare('SELECT * FROM link_node WHERE ref_no=?').get(refNo);
    const closed = platform.prepare("SELECT COUNT(*) c FROM link_rel WHERE to_ref_no=? AND rel_type='CLOSED_BY'").get(refNo).c;
    if (closed) disposed++;
    if (exist) continue;
    const his = businessDb('DS_HIS');
    const pat = his.prepare('SELECT patient_name, dept FROM inpatient WHERE inhos_no=?').get(r.patient_no);
    platform.prepare('INSERT INTO link_node(node_type,ref_no,title,concept_code,status,occurred_at,payload) VALUES (?,?,?,?,?,?,?)')
      .run('ALERT', refNo, `危急值：${r.item_name} 异常（${pat ? maskName(pat.patient_name) : r.patient_no}）`, 'LAB_REPORT', closed ? '已闭环' : '待处置', r.report_time,
        JSON.stringify({ inhos_no: r.patient_no, patient: pat ? maskName(pat.patient_name) : '', item: r.item_name, rule: 'RULE-QC-003', axiom: 'AX-004' }));
    if (!closed) {
      // 已有处置则闭环
      const dis = platform.prepare("SELECT ref_no FROM link_node WHERE node_type='DISPOSAL' AND title LIKE ?").get(`%${r.patient_no}%`);
      if (dis) platform.prepare('INSERT OR IGNORE INTO link_rel(from_ref_no,to_ref_no,rel_type,remark) VALUES (?,?,?,?)').run(refNo, dis.ref_no, 'CLOSED_BY', '处置关联');
      else created++;
    }
  }
  res.json(ok({ abnormalReports: abnormal.length, disposed, created }));
});

// ==================== RDF ABox 导出（脱敏） + SHACL 校验 ====================
C.get('/rdf/patient/:inhosNo', (req, res) => {
  const mask = req.query.mask !== 'false';
  const ttl = exportPatientTurtle(req.params.inhosNo, mask);
  res.setHeader('Content-Type', 'text/turtle;charset=UTF-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.inhosNo}.ttl"`);
  res.send(ttl);
});
export function exportPatientTurtle(inhosNo, mask = true) {
  const his = businessDb('DS_HIS'), emr = businessDb('DS_EMR'), lis = businessDb('DS_LIS'), ph = businessDb('DS_PHARMACY');
  const p = his.prepare('SELECT * FROM inpatient WHERE inhos_no=?').get(inhosNo);
  if (!p) throw new BizException('住院号不存在');
  const name = mask ? maskName(p.patient_name) : p.patient_name;
  const L = [];
  L.push(`# BeModel 患者住院 ABox 导出（${inhosNo}）${mask ? '（姓名已脱敏）' : '（未脱敏，仅内网调试）'}`);
  L.push(`@prefix med: <http://bemodel.com/ontology/med#> .`);
  L.push(`@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n`);
  L.push(`med:Patient_${inhosNo} a med:Patient ;`);
  L.push(`    med:sex "${p.sex}" ;`);
  L.push(`    med:age ${Number(p.age)} ;`);
  const allergies = emr.prepare('SELECT * FROM patient_allergy WHERE inhos_no=?').all(inhosNo);
  for (const a of allergies) L.push(`    med:hasAllergyTo med:Allergen_${encodeURIComponent(a.allergen)} ;`);
  L.push(`    med:hasEncounter med:Encounter_${inhosNo} .\n`);
  L.push(`med:Encounter_${inhosNo} a med:InpEncounter, med:Encounter ;`);
  L.push(`    med:admitTime "${p.admit_time}"^^xsd:dateTime ;`);
  L.push(`    med:status "${p.status}" .\n`);
  for (const a of allergies) L.push(`med:Allergen_${encodeURIComponent(a.allergen)} a med:Allergen ; med:allergenName "${a.allergen}" .\n`);
  const orders = his.prepare('SELECT * FROM medical_order WHERE inhos_no=?').all(inhosNo);
  const drugs = businessDb('DS_PHARMACY');
  for (const o of orders) {
    if (o.order_type === '检验') {
      const apply = lis.prepare('SELECT * FROM lab_apply WHERE order_id=?').get(o.order_id);
      if (apply) {
        const rep = lis.prepare('SELECT * FROM lab_report WHERE apply_id=?').get(apply.apply_id);
        L.push(`med:LabOrder_${o.order_id} a med:LabOrder ; med:orderStatus "${o.order_status}" .`);
        if (rep) L.push(`med:LabResult_${rep.report_id} a med:LabResult ; med:isAbnormal ${rep.result_status === 'A' ? 'true' : 'false'} ; med:ofOrder med:LabOrder_${o.order_id} .\n`);
      }
    } else if (o.order_type === '药品') {
      const drug = drugs.prepare('SELECT * FROM drug_dict WHERE drug_code=?').get(o.item_code);
      const disp = drugs.prepare('SELECT * FROM dispense_record WHERE order_id=?').get(o.order_id);
      const review = drugs.prepare('SELECT * FROM presc_review WHERE order_id=?').get(o.order_id);
      L.push(`med:DrugOrder_${o.order_id} a med:DrugOrder ;`);
      L.push(`    med:prescribesDrug med:Drug_${o.item_code} ;`);
      L.push(`    med:prescribedBy med:Doctor_${encodeURIComponent(o.doctor)} ;`);
      if (o.single_dose != null) L.push(`    med:singleDose ${Number(o.single_dose)}^^xsd:decimal ;`);
      if (o.frequency) L.push(`    med:frequency "${o.frequency}" ;`);
      L.push(`    med:orderStatus "${o.order_status}" .`);
      if (drug) {
        L.push(`med:Drug_${o.item_code} a med:Drug ; med:drugName "${drug.drug_name}" ;`);
        if (drug.max_daily_dose != null) L.push(`    med:maxDailyDose ${Number(drug.max_daily_dose)}^^xsd:decimal ;`);
        if (drug.allergen) L.push(`    med:containsAllergen "${drug.allergen}" ;`);
        L.push(`    med:childForbidden ${drug.child_forbidden === 'Y' ? 'true' : 'false'} .`);
      }
      if (review) L.push(`med:Prescription_${o.order_id} a med:Prescription ; med:prescribedBy med:Doctor_${encodeURIComponent(o.doctor)} ; med:reviewedBy med:Pharmacist_${encodeURIComponent(review.pharmacist || 'x')} .`);
      if (disp) L.push(`med:Dispense_${disp.dispense_id} a med:Dispense, med:ClinicalAct ; med:dispenseStatus "${disp.status}" .\n`);
    } else if (o.order_type === '检查') {
      L.push(`med:ExamOrder_${o.order_id} a med:ExamOrder ; med:orderStatus "${o.order_status}" .\n`);
    }
  }
  const diags = emr.prepare('SELECT * FROM emr_record WHERE inhos_no=?').all(inhosNo);
  for (const r of diags) {
    for (const d of String(r.diag_list || r.diag_main || '').split(',')) {
      const dd = emr.prepare('SELECT * FROM diag_dict WHERE diag_code=?').get(d);
      if (dd) L.push(`med:Diagnosis_${d}_${inhosNo} a med:Diagnosis ; med:diagName "${dd.diag_name}" ; med:icd10Code "${dd.icd10 || ''}" ; med:snomedCode "${dd.snomed_code || ''}" .`);
    }
  }
  return L.join('\n') + '\n';
}
C.post('/rdf/validate/:inhosNo', (req, res) => {
  const inhosNo = req.params.inhosNo;
  const violations = shaclValidatePatient(inhosNo);
  res.json(ok({
    patientId: inhosNo, conforms: violations.length === 0, violations,
    violationCount: violations.length, shapes: '6 Shapes', engine: 'BeModel 内置 SHACL 语义校验（复现版）',
  }));
});
function shaclValidatePatient(inhosNo) {
  const V = [];
  const his = businessDb('DS_HIS'), emr = businessDb('DS_EMR'), ph = businessDb('DS_PHARMACY');
  const p = his.prepare('SELECT * FROM inpatient WHERE inhos_no=?').get(inhosNo);
  if (!p) return [{ focusNode: 'Patient', path: 'exists', message: '患者不存在', severity: 'Violation' }];
  const allergies = emr.prepare('SELECT allergen FROM patient_allergy WHERE inhos_no=?').all(inhosNo).map(r => r.allergen);
  const orders = his.prepare("SELECT * FROM medical_order WHERE inhos_no=?").all(inhosNo);
  // Shape1 AllergyConstraint
  for (const o of orders.filter(o => o.order_type === '药品' && o.order_status !== '2')) {
    const drug = ph.prepare('SELECT * FROM drug_dict WHERE drug_code=?').get(o.item_code);
    if (drug?.allergen && allergies.includes(drug.allergen)) {
      V.push({ focusNode: `DrugOrder_${o.order_id}`, path: 'prescribesDrug', message: `患者过敏原「${drug.allergen}」与药品「${drug.drug_name}」冲突（AllergyConstraint）`, severity: 'Violation' });
    }
  }
  // Shape2 DoseLimit
  const freqFactor = { bid: 2, tid: 3, q8h: 3 };
  for (const o of orders.filter(o => o.order_type === '药品' && o.single_dose != null)) {
    const drug = ph.prepare('SELECT * FROM drug_dict WHERE drug_code=?').get(o.item_code);
    if (!drug || drug.max_daily_dose == null) continue;
    const daily = Number(o.single_dose) * (freqFactor[o.frequency] || 1);
    if (daily > Number(drug.max_daily_dose)) {
      V.push({ focusNode: `DrugOrder_${o.order_id}`, path: 'singleDose', message: `单日剂量 ${daily}${drug.dose_unit} 超过日最大剂量 ${drug.max_daily_dose}${drug.dose_unit}（DoseLimitShape）`, severity: 'Violation' });
    }
  }
  // Shape3 ChildForbidden
  for (const o of orders.filter(o => o.order_type === '药品')) {
    const drug = ph.prepare('SELECT * FROM drug_dict WHERE drug_code=?').get(o.item_code);
    if (drug?.child_forbidden === 'Y' && Number(p.age) < 14) {
      V.push({ focusNode: `DrugOrder_${o.order_id}`, path: 'prescribesDrug', message: `未成年患者（${p.age}岁）禁用「${drug.drug_name}」（ChildForbiddenShape）`, severity: 'Violation' });
    }
  }
  // Shape4 SexDisjointDiag
  const records = emr.prepare('SELECT * FROM emr_record WHERE inhos_no=?').all(inhosNo);
  if (p.sex === '男') {
    for (const r of records) {
      for (const d of String(r.diag_list || '').split(',')) {
        const dd = emr.prepare('SELECT icd10, diag_name FROM diag_dict WHERE diag_code=?').get(d);
        if (dd && (String(dd.icd10 || '').startsWith('O') || String(dd.icd10 || '').startsWith('N83'))) {
          V.push({ focusNode: `Diagnosis_${d}`, path: 'diagName', message: `男性患者出现诊断「${dd.diag_name}」（ICD-10 ${dd.icd10}），违反 AX-003（SexDisjointDiagShape）`, severity: 'Violation' });
        }
      }
    }
  }
  // Shape5 Interaction
  const drugOrders = orders.filter(o => o.order_type === '药品' && o.order_status !== '2');
  for (let i = 0; i < drugOrders.length; i++) {
    for (let j = i + 1; j < drugOrders.length; j++) {
      const d1 = ph.prepare('SELECT * FROM drug_dict WHERE drug_code=?').get(drugOrders[i].item_code);
      const d2 = ph.prepare('SELECT * FROM drug_dict WHERE drug_code=?').get(drugOrders[j].item_code);
      if (d1?.interacts_with && d1.interacts_with.split(',').includes(d2?.drug_code)) {
        V.push({ focusNode: `DrugOrder_${drugOrders[i].order_id}`, path: 'prescribesDrug', message: `「${d1.drug_name}」与「${d2.drug_name}」存在相互作用（InteractionShape）`, severity: 'Violation' });
      }
    }
  }
  // Shape6 Prescription 审方
  for (const o of drugOrders) {
    const review = ph.prepare('SELECT * FROM presc_review WHERE order_id=?').get(o.order_id);
    if (!review || !review.pharmacist) {
      V.push({ focusNode: `Prescription_${o.order_id}`, path: 'reviewedBy', message: `药品医嘱缺少药师审核（PrescriptionShape minCount 1）`, severity: 'Violation' });
    }
  }
  return V;
}

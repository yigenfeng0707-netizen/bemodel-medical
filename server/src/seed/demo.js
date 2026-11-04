import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { fmtDate, fmtDateTime, addDays } from '../db.js';

// =====================================================================
// 演示业务库 DataSeeder（对应原版 V2 DDL + DataSeeder 运行时播种）
// 原则：确定性（无 Random，全部取模轮转）、幂等（计数达标即跳过）、
//       住院医嘱全闭环、预埋 LIS 撤销码升级数据裂缝
// =====================================================================

const DDL = {
  demo_his: `
  CREATE TABLE IF NOT EXISTS inpatient(inhos_no TEXT PRIMARY KEY, patient_name TEXT, sex TEXT, age INTEGER, ward TEXT, dept TEXT, admit_time TEXT, discharge_time TEXT, status TEXT, doctor TEXT);
  CREATE TABLE IF NOT EXISTS medical_order(order_id TEXT PRIMARY KEY, inhos_no TEXT, item_code TEXT, item_name TEXT, order_type TEXT, order_status TEXT, doctor TEXT, create_time TEXT, cancel_time TEXT, single_dose REAL, dose_unit TEXT, frequency TEXT);
  CREATE TABLE IF NOT EXISTS fee_detail(fee_id TEXT PRIMARY KEY, inhos_no TEXT, order_id TEXT, item_code TEXT, item_name TEXT, amount REAL, fee_status TEXT, charge_time TEXT);
  CREATE TABLE IF NOT EXISTS status_map(src_system TEXT, src_status TEXT, src_status_name TEXT, target_action TEXT, updated_at TEXT, PRIMARY KEY(src_system, src_status));
  CREATE TABLE IF NOT EXISTS dept(dept_code TEXT PRIMARY KEY, dept_name TEXT, ward TEXT, category TEXT, bed_count INTEGER);
  CREATE TABLE IF NOT EXISTS staff(staff_id TEXT PRIMARY KEY, staff_name TEXT, role TEXT, title TEXT, dept_code TEXT);
  CREATE TABLE IF NOT EXISTS blood_apply(apply_id TEXT PRIMARY KEY, inhos_no TEXT, patient_name TEXT, blood_type TEXT, component TEXT, quantity REAL, apply_time TEXT, status TEXT);
  CREATE TABLE IF NOT EXISTS blood_transfusion(trans_id TEXT PRIMARY KEY, apply_id TEXT, inhos_no TEXT, blood_no TEXT, trans_time TEXT, nurse TEXT, reaction TEXT);`,
  demo_lis: `
  CREATE TABLE IF NOT EXISTS lab_apply(apply_id TEXT PRIMARY KEY, order_id TEXT, patient_no TEXT, patient_name TEXT, item_code TEXT, item_name TEXT, apply_status TEXT, apply_time TEXT, update_time TEXT);
  CREATE TABLE IF NOT EXISTS lab_report(report_id TEXT PRIMARY KEY, apply_id TEXT, patient_no TEXT, item_code TEXT, item_name TEXT, result_status TEXT, report_time TEXT, reporter TEXT);
  CREATE TABLE IF NOT EXISTS lab_dict_status(status_code TEXT, status_name TEXT, app_version TEXT, effective_date TEXT, end_date TEXT, PRIMARY KEY(status_code, app_version));`,
  demo_charge: `
  CREATE TABLE IF NOT EXISTS settlement(settle_id TEXT PRIMARY KEY, inhos_no TEXT, patient_name TEXT, total_amount REAL, settle_time TEXT, settle_status TEXT);
  CREATE TABLE IF NOT EXISTS refund_apply(refund_id TEXT PRIMARY KEY, inhos_no TEXT, fee_id TEXT, amount REAL, reason TEXT, apply_time TEXT, status TEXT);
  CREATE TABLE IF NOT EXISTS charge_audit(fee_id TEXT, action TEXT, operator TEXT, op_time TEXT);
  CREATE TABLE IF NOT EXISTS pay_record(pay_id TEXT PRIMARY KEY, inhos_no TEXT, amount REAL, pay_type TEXT, channel TEXT, pay_time TEXT, operator TEXT);
  CREATE TABLE IF NOT EXISTS invoice(invoice_id TEXT PRIMARY KEY, settle_id TEXT, inhos_no TEXT, patient_name TEXT, amount REAL, invoice_time TEXT, status TEXT);
  CREATE TABLE IF NOT EXISTS reconcile_record(rec_id TEXT PRIMARY KEY, rec_date TEXT, channel TEXT, system_amount REAL, channel_amount REAL, diff REAL, status TEXT);`,
  demo_pharmacy: `
  CREATE TABLE IF NOT EXISTS dispense_record(dispense_id TEXT PRIMARY KEY, order_id TEXT, patient_no TEXT, item_code TEXT, item_name TEXT, status TEXT, dispense_time TEXT, pharmacist TEXT);
  CREATE TABLE IF NOT EXISTS drug_dict(drug_code TEXT PRIMARY KEY, drug_name TEXT, max_daily_dose REAL, dose_unit TEXT, allergen TEXT, child_forbidden TEXT, interacts_with TEXT);
  CREATE TABLE IF NOT EXISTS purchase_order(po_id TEXT PRIMARY KEY, drug_code TEXT, drug_name TEXT, quantity INTEGER, unit_price REAL, supplier TEXT, status TEXT, create_time TEXT);
  CREATE TABLE IF NOT EXISTS stock_in(in_id TEXT PRIMARY KEY, po_id TEXT, drug_code TEXT, drug_name TEXT, quantity INTEGER, in_time TEXT, operator TEXT);
  CREATE TABLE IF NOT EXISTS stock_out(out_id TEXT PRIMARY KEY, drug_code TEXT, drug_name TEXT, quantity INTEGER, out_type TEXT, ref_id TEXT, out_time TEXT, operator TEXT);
  CREATE TABLE IF NOT EXISTS drug_stock(drug_code TEXT PRIMARY KEY, drug_name TEXT, quantity INTEGER, unit TEXT, warehouse TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS presc_review(review_id TEXT PRIMARY KEY, order_id TEXT, inhos_no TEXT, pharmacist TEXT, review_result TEXT, reject_reason TEXT, review_time TEXT);`,
  demo_opd: `
  CREATE TABLE IF NOT EXISTS opd_reg(reg_id TEXT PRIMARY KEY, pat_card_no TEXT, pat_name TEXT, reg_dept TEXT, reg_doctor TEXT, reg_fee REAL, reg_status TEXT, reg_time TEXT);
  CREATE TABLE IF NOT EXISTS opd_visit(visit_id TEXT PRIMARY KEY, card_no TEXT, diag TEXT, visit_time TEXT, doctor TEXT, status TEXT);
  CREATE TABLE IF NOT EXISTS opd_presc(presc_id TEXT PRIMARY KEY, visit_id TEXT, card_no TEXT, item_code TEXT, item_name TEXT, item_type TEXT, quantity INTEGER, price REAL, presc_status TEXT, create_time TEXT);`,
  demo_emr: `
  CREATE TABLE IF NOT EXISTS emr_record(record_id TEXT PRIMARY KEY, inhos_no TEXT, patient_name TEXT, record_type TEXT, diag_main TEXT, diag_list TEXT, content TEXT, doctor TEXT, create_time TEXT, qc_status TEXT DEFAULT '未质控');
  CREATE TABLE IF NOT EXISTS emr_surgery(surg_id TEXT PRIMARY KEY, inhos_no TEXT, proc_name TEXT, proc_time TEXT, surgeon TEXT, proc_level TEXT);
  CREATE TABLE IF NOT EXISTS diag_dict(diag_code TEXT PRIMARY KEY, diag_name TEXT, snomed_code TEXT, icd10 TEXT);
  CREATE TABLE IF NOT EXISTS patient_allergy(id INTEGER PRIMARY KEY AUTOINCREMENT, inhos_no TEXT, allergen TEXT, severity TEXT);
  CREATE TABLE IF NOT EXISTS anesthesia_record(anes_id TEXT PRIMARY KEY, surg_id TEXT, inhos_no TEXT, anesthetist TEXT, method TEXT, start_time TEXT, end_time TEXT);
  CREATE TABLE IF NOT EXISTS drg_group(drg_id TEXT PRIMARY KEY, record_id TEXT, inhos_no TEXT, drg_code TEXT, drg_name TEXT, weight REAL, group_time TEXT);
  CREATE TABLE IF NOT EXISTS infection_report(report_id TEXT PRIMARY KEY, inhos_no TEXT, patient_name TEXT, infection_type TEXT, pathogen TEXT, report_time TEXT, status TEXT);
  CREATE TABLE IF NOT EXISTS followup(fu_id TEXT PRIMARY KEY, inhos_no TEXT, patient_name TEXT, fu_type TEXT, plan_time TEXT, done_time TEXT, status TEXT, content TEXT);`,
  demo_pacs: `
  CREATE TABLE IF NOT EXISTS exam_report(exam_id TEXT PRIMARY KEY, order_id TEXT, patient_no TEXT, patient_name TEXT, item_code TEXT, item_name TEXT, abnormal_flag TEXT, conclusion TEXT, exam_time TEXT, report_time TEXT, technician TEXT, reviewer TEXT);`,
  demo_nurse: `
  CREATE TABLE IF NOT EXISTS nurse_exec(exec_id TEXT PRIMARY KEY, order_id TEXT, inhos_no TEXT, exec_type TEXT, exec_time TEXT, nurse TEXT, exec_status TEXT);
  CREATE TABLE IF NOT EXISTS vital_sign(vs_id TEXT PRIMARY KEY, inhos_no TEXT, patient_name TEXT, record_time TEXT, temperature REAL, pulse INTEGER, bp TEXT, nurse TEXT);`,
  demo_material: `
  CREATE TABLE IF NOT EXISTS material_stock(material_code TEXT PRIMARY KEY, material_name TEXT, spec TEXT, quantity INTEGER, unit TEXT, warehouse TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS material_apply(apply_id TEXT PRIMARY KEY, material_code TEXT, material_name TEXT, quantity INTEGER, apply_dept TEXT, apply_time TEXT, status TEXT, picker TEXT);
  CREATE TABLE IF NOT EXISTS material_in(in_id TEXT PRIMARY KEY, material_code TEXT, material_name TEXT, quantity INTEGER, in_time TEXT, operator TEXT);
  CREATE TABLE IF NOT EXISTS material_out(out_id TEXT PRIMARY KEY, apply_id TEXT NOT NULL, material_code TEXT, material_name TEXT, quantity INTEGER, out_dept TEXT, out_time TEXT, picker TEXT);`,
};

const EXTRA_NAMES = ['邓超群', '孙晓梅', '钱志远', '许静怡', '朱建国', '蒋文娟', '沈国强', '韩雪莹', '杨军', '曾丽华', '彭志明', '吕秀珍', '肖劲光', '田雨晴', '董海涛', '潘美玲', '袁明辉', '蔡淑芬', '余光辉', '杜鹏飞', '叶春兰', '程志刚', '苏婉清', '魏东升', '罗建平', '梁咏琪', '宋子豪', '唐心怡'];
const WARDS = ['心内科病区', '呼吸内科病区', '普外科病区', '骨科病区', '儿科病区'];
const INP_DEPTS = ['心内科', '呼吸内科', '普外科', '骨科', '儿科'];
const DOCTORS = ['王建平', '李淑华', '张伟民', '刘芳', '陈志强', '赵国庆', '孙明'];
const NURSES = ['王芳', '李娜', '张丽', '刘敏'];
const PHARMACISTS = ['周颖', '吴药师'];

// 12 种药品字典（含两个违规锚点：头孢过敏 / 布洛芬超量）
const DRUGS = [
  ['D001', '阿莫西林胶囊', 1.5, 'g', null, 'N', ''],
  ['D002', '布洛芬缓释胶囊', 2.4, 'g', null, 'Y', ''],
  ['D003', '注射用头孢呋辛钠', 6.0, 'g', '头孢菌素', 'N', 'D004'],
  ['D004', '奥美拉唑肠溶胶囊', 0.04, 'g', null, 'N', 'D003'],
  ['D005', '氨氯地平片', 0.01, 'g', null, 'N', ''],
  ['D006', '二甲双胍片', 2.0, 'g', null, 'N', ''],
  ['D007', '阿托伐他汀钙片', 0.08, 'g', null, 'N', ''],
  ['D008', '头孢克肟颗粒', 0.4, 'g', '头孢菌素', 'N', 'D001'],
  ['D009', '氯雷他定片', 0.01, 'g', null, 'N', ''],
  ['D010', '蒙脱石散', 0.009, 'g', null, 'N', ''],
  ['D011', '注射用青霉素钠', 9.6, 'g', '青霉素', 'N', ''],
  ['D012', '对乙酰氨基酚片', 2.0, 'g', null, 'Y', ''],
];
const LAB_ITEMS = [['L001', '血常规', 25], ['L002', '尿常规', 15], ['L003', '肝功能', 60], ['L004', '凝血四项', 80], ['L005', '血糖', 20], ['L006', 'C反应蛋白', 40]];
const EXAM_ITEMS = [['E001', '胸部CT', 320], ['E002', '胸部DR', 120], ['E003', '腹部B超', 150]];

const DEPTS = [
  ['D01', '心内科', '心内科病区', '临床', 60], ['D02', '呼吸内科', '呼吸内科病区', '临床', 55],
  ['D03', '普外科', '普外科病区', '临床', 50], ['D04', '骨科', '骨科病区', '临床', 45],
  ['D05', '儿科', '儿科病区', '临床', 40], ['D06', '检验科', '', '医技', 0],
  ['D07', '影像科', '', '医技', 0], ['D08', '药学部', '', '医技', 0],
  ['D09', '收费处', '', '职能', 0], ['D10', '护理部', '', '职能', 0],
  ['D11', '病案室', '', '职能', 0], ['D12', '医务处', '', '职能', 0],
];
const STAFFS = [
  ['S001', '王建平', '医生', '主任医师', 'D01'], ['S002', '李淑华', '医生', '副主任医师', 'D01'],
  ['S003', '张伟民', '医生', '主治医师', 'D02'], ['S004', '刘芳', '医生', '主治医师', 'D03'],
  ['S005', '陈志强', '医生', '副主任医师', 'D04'], ['S006', '赵国庆', '医生', '主任医师', 'D02'],
  ['S007', '孙明', '医生', '主治医师', 'D05'], ['S008', '周颖', '药师', '主管药师', 'D08'],
  ['S009', '吴刚', '药师', '药师', 'D08'], ['S010', '王芳', '护士', '主管护师', 'D01'],
  ['S011', '李娜', '护士', '护师', 'D02'], ['S012', '张丽', '护士', '护师', 'D03'],
  ['S013', '刘敏', '护士', '护士', 'D04'], ['S014', '郑洁', '护士', '护师', 'D05'],
  ['S015', '何静', '病案质控', '副研究员', 'D11'], ['S016', '马晓东', '收费员', '职员', 'D09'],
  ['S017', '林小雨', '技师', '技师', 'D06'],
];

const DIAGS = [
  ['DG001', '高血压', '38341003', 'I10'], ['DG002', '2型糖尿病', '44054006', 'E11'],
  ['DG003', '肺炎', '233604007', 'J18.9'], ['DG004', '上呼吸道感染', '54150009', 'J06.9'],
  ['DG005', '急性胃肠炎', '40956001', 'K52.9'], ['DG006', '肺部感染', '', 'J98.4'],
  ['DG007', '尺骨骨折', '', 'S82.5'], ['DG008', '冠状动脉粥样硬化性心脏病', '53741008', 'I25.1'],
  ['DG009', '慢性支气管炎', '', 'J42'], ['DG010', '胆囊结石', '55505002', 'K80.2'],
  ['DG011', '急性阑尾炎', '77538008', 'K35.9'], ['DG012', '卵巢囊肿', '', 'N83.2'],
  ['DG013', '妊娠状态', '', 'Z34.9'], ['DG014', '支气管哮喘', '195967001', 'J45.9'],
  ['DG015', '慢性肾功能不全', '', 'N18.9'],
];
const DRG_MAP = { DG001: ['DRG01','循环系统疾病-简单',0.7], DG002: ['DRG02','内分泌疾病-简单',0.8], DG003: ['DRG03','呼吸系统感染-中等',1.1], DG004: ['DRG04','呼吸系统感染-简单',0.7], DG005: ['DRG05','消化系统疾病-简单',0.75], DG006: ['DRG06','呼吸系统感染-中等',1.0], DG007: ['DRG07','骨骼手术-中等',1.5], DG008: ['DRG08','循环系统疾病-复杂',2.1], DG009: ['DRG09','呼吸系统疾病-中等',0.95], DG010: ['DRG10','消化手术-中等',1.6], DG011: ['DRG11','消化手术-简单',1.2], DG012: ['DRG12','妇科疾病-简单',0.8], DG013: ['DRG13','妊娠相关-简单',0.7], DG014: ['DRG14','呼吸系统疾病-中等',0.9], DG015: ['DRG15','泌尿系统疾病-中等',1.3] };

// 预埋裂缝患者（order_status=2 取消、fee_status=1 仍计费、LIS 撤销码 C）
const FAULTS = [
  { idx: 0, item: LAB_ITEMS[0] },  // 张建国 血常规 ¥25
  { idx: 3, item: LAB_ITEMS[2] },  // 王秀兰 肝功能 ¥60
  { idx: 2, item: LAB_ITEMS[3] },  // 王强 凝血四项 ¥80
  { idx: 4, item: LAB_ITEMS[1] },  // 刘伟 尿常规 ¥15
  { idx: 6, item: LAB_ITEMS[0] },  // 杨光 血常规 ¥25
];
// 对照组：升级前已正常退费（撤销码 X）
const HIST_REFUND = [
  { idx: 10, item: LAB_ITEMS[0] }, // 郑国庆 血常规
  { idx: 11, item: LAB_ITEMS[2] }, // 冯雪 肝功能
];

const PATIENTS_12 = [
  { name: '张建国', sex: '男', age: 58, ward: WARDS[0], dept: INP_DEPTS[0], admit: '2026-08-15', stay: 9, doctor: DOCTORS[0], diag: 'DG008' },
  { name: '李红梅', sex: '女', age: 45, ward: WARDS[1], dept: INP_DEPTS[1], admit: '2026-08-16', stay: 7, doctor: DOCTORS[1], diag: 'DG003' },
  { name: '王强', sex: '男', age: 52, ward: WARDS[0], dept: INP_DEPTS[0], admit: '2026-08-10', stay: 12, doctor: DOCTORS[0], diag: 'DG001' },
  { name: '王秀兰', sex: '女', age: 66, ward: WARDS[1], dept: INP_DEPTS[1], admit: '2026-08-18', stay: 8, doctor: DOCTORS[5], diag: 'DG006' },
  { name: '刘伟', sex: '男', age: 39, ward: WARDS[2], dept: INP_DEPTS[2], admit: '2026-08-20', stay: 6, doctor: DOCTORS[3], diag: 'DG011' },
  { name: '陈芳', sex: '女', age: 71, ward: WARDS[0], dept: INP_DEPTS[0], admit: '2026-08-05', stay: 14, doctor: DOCTORS[0], diag: 'DG008' },
  { name: '杨光', sex: '男', age: 33, ward: WARDS[1], dept: INP_DEPTS[1], admit: '2026-08-22', stay: 5, doctor: DOCTORS[2], diag: 'DG014' },
  { name: '赵敏', sex: '女', age: 28, ward: WARDS[2], dept: INP_DEPTS[2], admit: '2026-08-24', stay: 5, doctor: DOCTORS[3], diag: 'DG010' },
  { name: '周杰', sex: '男', age: 61, ward: WARDS[0], dept: INP_DEPTS[0], admit: '2026-08-25', stay: 7, doctor: DOCTORS[1], diag: 'DG001' },
  { name: '吴丽丽', sex: '女', age: 36, ward: WARDS[4], dept: INP_DEPTS[4], admit: '2026-08-28', stay: 4, doctor: DOCTORS[6], diag: 'DG004' },
  { name: '郑国庆', sex: '男', age: 69, ward: WARDS[0], dept: INP_DEPTS[0], admit: '2026-08-02', stay: 13, doctor: DOCTORS[0], diag: 'DG008' },
  { name: '冯雪', sex: '女', age: 12, ward: WARDS[4], dept: INP_DEPTS[4], admit: '2026-07-28', stay: 10, doctor: DOCTORS[6], diag: 'DG004' },
];

function dbFile(name) {
  const f = path.join(config.dataDir, `${name}.db`);
  for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(f + suffix); } catch { /* ignore */ } }
  const db = new DatabaseSync(f);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec(DDL[name]);
  return db;
}

export function seedDemoDbs(force = false) {
  // 幂等：平台首库存在且数据达标则跳过
  if (!force && fs.existsSync(config.demoDbs.DS_HIS)) {
    try {
      const check = new DatabaseSync(config.demoDbs.DS_HIS, { readOnly: true });
      const c = check.prepare('SELECT COUNT(*) c FROM inpatient').get().c;
      if (c >= 41) return false;
    } catch { /* 重建 */ }
  }
  const his = dbFile('demo_his'), lis = dbFile('demo_lis'), charge = dbFile('demo_charge');
  const ph = dbFile('demo_pharmacy'), opd = dbFile('demo_opd'), emr = dbFile('demo_emr');
  const pacs = dbFile('demo_pacs'), nurse = dbFile('demo_nurse'), mat = dbFile('demo_material');
  const T = fmtDateTime(new Date('2026-09-10T10:00:00'));

  // ---------- 主数据 ----------
  for (const d of DEPTS) his.prepare('INSERT INTO dept VALUES (?,?,?,?,?)').run(...d);
  for (const s of STAFFS) his.prepare('INSERT INTO staff VALUES (?,?,?,?,?)').run(...s);
  // 故障根因：LIS 撤销码 X→C 升级，HIS 计费适配器 status_map 缺 C 行
  his.prepare('INSERT INTO status_map VALUES (?,?,?,?,?)').run('LIS', 'N', '已采样', 'CHARGE', T);
  his.prepare('INSERT INTO status_map VALUES (?,?,?,?,?)').run('LIS', 'P', '已发布', 'KEEP', T);
  his.prepare('INSERT INTO status_map VALUES (?,?,?,?,?)').run('LIS', 'X', '已撤销(v5.1)', 'REFUND', T);
  lis.prepare('INSERT INTO lab_dict_status VALUES (?,?,?,?,?)').run('N', '已采样', 'v5.1', '2025-01-01', '2026-08-14');
  lis.prepare('INSERT INTO lab_dict_status VALUES (?,?,?,?,?)').run('P', '已发布', 'v5.1', '2025-01-01', '2026-08-14');
  lis.prepare('INSERT INTO lab_dict_status VALUES (?,?,?,?,?)').run('X', '已撤销', 'v5.1', '2025-01-01', '2026-08-14');
  lis.prepare('INSERT INTO lab_dict_status VALUES (?,?,?,?,?)').run('N', '已采样', 'v5.2', '2026-08-15', null);
  lis.prepare('INSERT INTO lab_dict_status VALUES (?,?,?,?,?)').run('P', '已发布', 'v5.2', '2026-08-15', null);
  lis.prepare('INSERT INTO lab_dict_status VALUES (?,?,?,?,?)').run('C', '已撤销', 'v5.2', '2026-08-15', null);

  for (const d of DRUGS) ph.prepare('INSERT INTO drug_dict VALUES (?,?,?,?,?,?,?)').run(...d);
  for (const d of DIAGS) emr.prepare('INSERT INTO diag_dict VALUES (?,?,?,?)').run(...d);

  // ---------- 41 名住院患者 ----------
  const patients = [];
  for (let i = 0; i < 12; i++) {
    const p = PATIENTS_12[i];
    const discharge = addDays(new Date(p.admit + 'T00:00:00'), p.stay);
    const out = discharge < new Date('2026-09-09T23:59:00');
    patients.push({
      ...p, idx: i,
      discharge: out ? fmtDate(discharge) : null,
      status: out ? '出院' : '在院',
      inhos: `ZY2026${p.admit.slice(5, 7)}${p.admit.slice(8, 10)}${String(i + 1).padStart(3, '0')}`,
    });
  }
  for (let k = 0; k < 28; k++) {
    const i = 12 + k;
    const admit = addDays(new Date('2026-08-25T08:00:00'), k % 15);
    admit.setHours(8 + (k % 9));
    const stay = 6 + (k % 8);
    const discharge = addDays(admit, stay);
    const out = discharge < new Date('2026-09-09T23:59:00');
    patients.push({
      idx: i, name: EXTRA_NAMES[k], sex: k % 2 ? '女' : '男', age: 25 + (k * 7) % 55,
      ward: WARDS[k % 5], dept: INP_DEPTS[k % 5], admit: fmtDate(admit), stay,
      discharge: out ? fmtDate(discharge) : null, status: out ? '出院' : '在院',
      doctor: DOCTORS[k % 6], diag: ['DG001', 'DG003', 'DG004', 'DG005', 'DG009'][k % 5],
      inhos: `ZY2026${fmtDate(admit).slice(5, 7)}${fmtDate(admit).slice(8, 10)}${String(i + 1).padStart(3, '0')}`,
    });
  }
  patients.push({ idx: 40, name: '韩小梅', sex: '女', age: 8, ward: WARDS[4], dept: INP_DEPTS[4], admit: '2026-09-03', stay: 5, discharge: '2026-09-08', status: '出院', doctor: DOCTORS[6], diag: 'DG004', inhos: 'ZY20260903041' });

  const faultBy = new Map(FAULTS.map(f => [f.idx, f]));
  const histBy = new Map(HIST_REFUND.map(f => [f.idx, f]));
  const drugRefundSet = new Set();
  let seq = { mo: 0, fee: 0, lab: 0, rep: 0, dis: 0, set: 0, pay: 0, inv: 0, ref: 0, nsg: 0, vs: 0, sur: 0, ane: 0, drg: 0, rec: 0, exam: 0, blood: 0, fu: 0, inf: 0, pr: 0 };
  const id = (p, n) => `${p}${String(n).padStart(4, '0')}`;

  for (const p of patients) {
    const admit = new Date(p.admit + 'T08:00:00');
    const discharged = p.status === '出院' || !!p.discharge;
    const dischargeAt = discharged ? new Date((p.discharge || p.admit) + 'T10:00:00') : null;
    his.prepare('INSERT INTO inpatient VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      p.inhos, p.name, p.sex, p.age, p.ward, p.dept, fmtDateTime(admit), p.discharge ? fmtDate(dischargeAt) : null, p.status || (p.discharge ? '出院' : '在院'), p.doctor);

    // 医嘱集合：检验（血常规每人、尿常规偶数、肝功能 i%3==0、CRP i%5==2）+ 检查（CT i%3==0、DR i%4==1）+ 药品 2+i%3 种
    const orders = [];
    const labsToOrder = new Set(['L001']);
    if (p.idx % 2 === 0) labsToOrder.add('L002');
    if (p.idx % 3 === 0) labsToOrder.add('L003');
    if (p.idx % 5 === 2 || p.idx === 1) labsToOrder.add('L006'); // 李红梅 CRP（质控矛盾锚点）
    const fault = faultBy.get(p.idx), hist = histBy.get(p.idx);
    if (fault) labsToOrder.add(fault.item[0]);
    if (hist) labsToOrder.add(hist.item[0]);
    if (p.idx === 0) labsToOrder.add('L005'); // 张建国：糖尿病需血糖（对照质控）
    // 手术患者术前须有凝血四项（idx=4 刘伟故意缺失 → PREOP 质控矛盾）
    const hasSurgery = p.idx % 6 === 4;
    if (hasSurgery && p.idx !== 4) labsToOrder.add('L004');
    const exams = [];
    if (p.idx % 3 === 0) exams.push('E001');
    if (p.idx % 4 === 1) exams.push('E002');
    if (p.idx % 7 === 3) exams.push('E003');
    const drugIdx = [];
    for (let j = 0; j < 2 + (p.idx % 3); j++) drugIdx.push((p.idx + j) % 11);

    const orderList = [];
    const mkOrder = (type, code, name, price, extra = {}) => {
      const n = ++seq.mo;
      const o = { order_id: id('MO', n), type, code, name, price, status: '1', create: fmtDateTime(addDays(admit, -0)), ...extra };
      orderList.push(o);
      return o;
    };
    for (const code of labsToOrder) {
      const it = LAB_ITEMS.find(x => x[0] === code);
      mkOrder('检验', it[0], it[1], it[2]);
    }
    for (const code of exams) {
      const it = EXAM_ITEMS.find(x => x[0] === code);
      mkOrder('检查', it[0], it[1], it[2]);
    }
    for (const di of drugIdx) {
      const d = DRUGS[di];
      let dose = round2(d[2] / 3), freq = 'tid';
      if (p.name === '冯雪' && d[0] === 'D002') { dose = 1.0; freq = 'tid'; } // 预埋超量违规：3g > 2.4g
      mkOrder('药品', d[0], d[1], round2(dose * (freq === 'tid' ? 3 : 2) * 10), { single_dose: dose, dose_unit: d[3], frequency: freq });
    }
    // 陈芳：头孢过敏但开了头孢（GATE 实验 / AX-007 锚点）
    if (p.name === '陈芳') {
      const d = DRUGS[2];
      mkOrder('药品', d[0], d[1], 120, { single_dose: 2.0, dose_unit: 'g', frequency: 'tid' });
      emr.prepare('INSERT INTO patient_allergy(inhos_no, allergen, severity) VALUES (?,?,?)').run(p.inhos, '头孢菌素', '严重');
    }
    if (p.name === '韩小梅') {
      const d = DRUGS[1]; // 儿童开具布洛芬缓释胶囊（12 岁以下不宜，SHACL Shape3 锚点）
      mkOrder('药品', d[0], d[1], 96, { single_dose: 0.9, dose_unit: 'g', frequency: 'bid' });
    }

    let settleAmount = 0;
    for (const o of orderList) {
      // 数据裂缝判断
      const isFault = fault && o.code === fault.item[0] && o.type === '检验';
      const isHist = hist && o.code === hist.item[0] && o.type === '检验';
      let ostatus = '1', cancelTime = null;
      if (isFault) { ostatus = '2'; cancelTime = fmtDateTime(new Date('2026-08-30T09:30:00')); }
      if (isHist) { ostatus = '2'; cancelTime = fmtDateTime(addDays(admit, 1)).slice(0, 11) + '09:00:00'; } // 升级(08-15)前
      his.prepare('INSERT INTO medical_order VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
        o.order_id, p.inhos, o.code, o.name, o.type, ostatus, p.doctor, o.create, cancelTime, o.single_dose || null, o.dose_unit || null, o.frequency || null);

      if (isFault || isHist) {
        // 检验申请：裂缝走新码 C（升级后），历史对照走旧码 X
        const n = ++seq.lab;
        const applyStatus = isFault ? 'C' : 'X';
        lis.prepare('INSERT INTO lab_apply VALUES (?,?,?,?,?,?,?,?,?)').run(
          id('LA', n), o.order_id, p.inhos, p.name, o.code, o.name, applyStatus, o.create, cancelTime || o.create);
        // 费用：裂缝 = 取消但未退费（fee_status=1）；历史 = 已退费（fee_status=2 + refund_apply + 退费审计）
        const n2 = ++seq.fee;
        const feeStatus = isFault ? '1' : '2';
        his.prepare('INSERT INTO fee_detail VALUES (?,?,?,?,?,?,?,?)').run(
          id('F', n2), p.inhos, o.order_id, o.code, o.name, o.price, feeStatus, isFault ? o.create : fmtDateTime(addDays(admit, 1)));
        charge.prepare('INSERT INTO charge_audit VALUES (?,?,?,?)').run(id('F', n2), 'CHARGE', '马晓东', o.create);
        if (isHist) {
          const n3 = ++seq.ref;
          charge.prepare('INSERT INTO refund_apply VALUES (?,?,?,?,?,?,?)').run(id('RA', n3), p.inhos, id('F', n2), o.price, '检验取消退费', cancelTime, '2');
          charge.prepare('INSERT INTO charge_audit VALUES (?,?,?,?)').run(id('F', n2), 'REFUND', '马晓东', cancelTime);
        }
        continue; // 取消的不进后续闭环
      }

      // 正常闭环：计费
      const n2 = ++seq.fee;
      his.prepare('INSERT INTO fee_detail VALUES (?,?,?,?,?,?,?,?)').run(
        id('F', n2), p.inhos, o.order_id, o.code, o.name, o.price, '1', fmtDateTime(addDays(admit, 1)));
      charge.prepare('INSERT INTO charge_audit VALUES (?,?,?,?)').run(id('F', n2), 'CHARGE', '马晓东', fmtDateTime(addDays(admit, 1)));
      settleAmount += o.price;

      if (o.type === '检验') {
        const n = ++seq.lab;
        lis.prepare('INSERT INTO lab_apply VALUES (?,?,?,?,?,?,?,?,?)').run(id('LA', n), o.order_id, p.inhos, p.name, o.code, o.name, 'P', fmtDateTime(addDays(admit, 1)), fmtDateTime(addDays(admit, 2)));
        const n4 = ++seq.rep;
        const abnormal = (p.idx === 1 && o.code === 'L006'); // 李红梅 CRP 异常未处置（质控矛盾）
        lis.prepare('INSERT INTO lab_report VALUES (?,?,?,?,?,?,?,?)').run(
          id('LR', n4), id('LA', n), p.inhos, o.code, o.name, abnormal ? 'A' : 'N', fmtDateTime(addDays(admit, 2)), '林小雨');
        const n5 = ++seq.nsg;
        nurse.prepare('INSERT INTO nurse_exec VALUES (?,?,?,?,?,?,?)').run(id('NE', n5), o.order_id, p.inhos, '采样', fmtDateTime(addDays(admit, 1)), NURSES[p.idx % 4], '1');
      } else if (o.type === '检查') {
        const n5 = ++seq.nsg;
        nurse.prepare('INSERT INTO nurse_exec VALUES (?,?,?,?,?,?,?)').run(id('NE', n5), o.order_id, p.inhos, '检查陪送', fmtDateTime(addDays(admit, 1)), NURSES[p.idx % 4], '1');
        const n6 = ++seq.exam;
        const abnormal = (p.idx === 2 && o.code === 'E001');
        pacs.prepare('INSERT INTO exam_report VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
          id('EX', n6), o.order_id, p.inhos, p.name, o.code, o.name, abnormal ? 'Y' : 'N', abnormal ? '右肺阴影，建议进一步检查' : '未见明显异常', fmtDateTime(addDays(admit, 1)), fmtDateTime(addDays(admit, 2)), '林小雨', '赵国庆');
      } else if (o.type === '药品') {
        const n7 = ++seq.dis;
        ph.prepare('INSERT INTO dispense_record VALUES (?,?,?,?,?,?,?,?)').run(
          id('DP', n7), o.order_id, p.inhos, o.code, o.name, '1', fmtDateTime(addDays(admit, 1)), PHARMACISTS[p.idx % 2]);
        ph.prepare('INSERT INTO presc_review VALUES (?,?,?,?,?,?,?)').run(
          id('PR', ++seq.pr), o.order_id, p.inhos, '周颖', (p.name === '冯雪' && o.code === 'D002') ? '驳回' : '通过', (p.name === '冯雪' && o.code === 'D002') ? '单日剂量超限（1.0g tid = 3g > 2.4g）' : null, fmtDateTime(admit));
        const n5 = ++seq.nsg;
        nurse.prepare('INSERT INTO nurse_exec VALUES (?,?,?,?,?,?,?)').run(id('NE', n5), o.order_id, p.inhos, '给药', fmtDateTime(addDays(admit, 1)), NURSES[p.idx % 4], '1');
      }
    }

    // 出院结算闭环
    if (discharged) {
      const n = ++seq.set;
      charge.prepare('INSERT INTO settlement VALUES (?,?,?,?,?,?)').run(id('ST', n), p.inhos, p.name, round2(settleAmount), fmtDateTime(dischargeAt), '1');
      const prepay = 2000 + (p.idx % 5) * 1000;
      const diff = round2(settleAmount - prepay);
      const n2 = ++seq.pay;
      if (diff >= 0) {
        charge.prepare('INSERT INTO pay_record VALUES (?,?,?,?,?,?,?)').run(id('PAY', n2), p.inhos, diff, '2', ['现金', '扫码', '医保'][p.idx % 3], fmtDateTime(dischargeAt), '马晓东');
      } else {
        charge.prepare('INSERT INTO pay_record VALUES (?,?,?,?,?,?,?)').run(id('PAY', n2), p.inhos, prepay, '1', ['现金', '扫码', '医保'][p.idx % 3], fmtDateTime(admit), '马晓东');
        const n3 = ++seq.pay;
        charge.prepare('INSERT INTO pay_record VALUES (?,?,?,?,?,?,?)').run(id('PAY', n3), p.inhos, -diff, '3', '现金', fmtDateTime(dischargeAt), '马晓东');
      }
      const n4 = ++seq.inv;
      charge.prepare('INSERT INTO invoice VALUES (?,?,?,?,?,?,?)').run(id('INV', n4), id('ST', n), p.inhos, p.name, round2(settleAmount), fmtDateTime(dischargeAt), '已开');
    } else {
      const prepay = 2000 + (p.idx % 5) * 1000;
      const n2 = ++seq.pay;
      charge.prepare('INSERT INTO pay_record VALUES (?,?,?,?,?,?,?)').run(id('PAY', n2), p.inhos, prepay, '1', ['现金', '扫码', '医保'][p.idx % 3], fmtDateTime(admit), '马晓东');
    }
  }

  // 药品取消但退药退费联动正常（对照组：证明裂缝只在 LIS 检验线）
  for (const p of patients) {
    if (p.idx >= 12 && p.idx % 8 === 5) {
      const n = ++seq.mo;
      const d = DRUGS[9];
      const cancelAt = fmtDateTime(addDays(new Date(p.admit + 'T08:00:00'), 2));
      his.prepare('INSERT INTO medical_order VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id('MO', n), p.inhos, d[0], d[1], '药品', '2', p.doctor, cancelAt, cancelTime(cancelAt), 0.003, 'g', 'tid');
      const n2 = ++seq.fee;
      his.prepare('INSERT INTO fee_detail VALUES (?,?,?,?,?,?,?,?)').run(id('F', n2), p.inhos, id('MO', n), d[0], d[1], 45, '2', cancelAt);
      const n3 = ++seq.ref;
      charge.prepare('INSERT INTO refund_apply VALUES (?,?,?,?,?,?,?)').run(id('RA', n3), p.inhos, id('F', n2), 45, '退药退费', cancelAt, '2');
      const n4 = ++seq.dis;
      ph.prepare('INSERT INTO dispense_record VALUES (?,?,?,?,?,?,?,?)').run(id('DP', n4), id('MO', n), p.inhos, d[0], d[1], '2', cancelAt, PHARMACISTS[p.idx % 2]);
    }
  }

  // ---------- 手术/麻醉/病案/院感/随访/生命体征 ----------
  const surgPatients = patients.filter((_, i) => i % 6 === 4);
  surgPatients.forEach((p, k) => {
    const at = fmtDateTime(addDays(new Date(p.admit + 'T08:00:00'), 2));
    const procs = [['腹腔镜阑尾切除术', '三级'], ['骨折切开复位内固定术', '三级'], ['腹腔镜胆囊切除术', '三级']];
    const pr = procs[k % 3];
    const n = ++seq.sur;
    emr.prepare('INSERT INTO emr_surgery VALUES (?,?,?,?,?,?)').run(id('SG', n), p.inhos, pr[0], at, p.doctor, pr[1]);
    const n2 = ++seq.ane;
    emr.prepare('INSERT INTO anesthesia_record VALUES (?,?,?,?,?,?,?)').run(id('AN', n2), id('SG', n), p.inhos, '麻醉科医师', '全身麻醉', at, fmtDateTime(addDays(new Date(at), 0)));
  });
  // 病案：全部出院患者，其中预埋质控矛盾
  const qcPlan = new Map([
    [1, 'CRP_ABNORMAL_NO_COVER'],  // 李红梅：CRP 异常但无后续抗生素处置
    [2, 'SEX_DISJOINT'],           // 王强：男性卵巢囊肿（AX-003）
    [4, 'PREOP_NO_COAG'],          // 刘伟：手术但术前缺凝血四项
    [5, 'DIAB_NO_GLUCOSE'],        // 陈芳：糖尿病诊断无血糖检验
  ]);
  for (const p of patients) {
    if (!p.status || p.status !== '出院') continue;
    const plan = qcPlan.get(p.idx);
    let diagList = p.diag;
    if (plan === 'SEX_DISJOINT') diagList = p.diag + ',DG012';
    if (plan === 'DIAB_NO_GLUCOSE') diagList = p.diag + ',DG002';
    const at = fmtDateTime(addDays(new Date(p.admit + 'T08:00:00'), 1));
    emr.prepare('INSERT INTO emr_record VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      id('MR', p.idx + 1), p.inhos, p.name, p.idx % 3 === 0 ? '病案首页' : '出院小结', p.diag, diagList,
      `患者${p.name}，因${DIAGS.find(d => d[0] === p.diag)?.[1] || ''}入院，经治疗后好转出院。`, p.doctor, at, '未质控');
    if (p.diag) {
      const g = DRG_MAP[p.diag];
      const n5 = ++seq.drg;
      emr.prepare('INSERT INTO drg_group VALUES (?,?,?,?,?,?,?)').run(id('DRG', n5), id('MR', p.idx + 1), p.inhos, g[0], g[1], g[2], fmtDateTime(addDays(new Date((p.discharge || p.admit) + 'T10:00:00'), 0)));
    }
  }

  for (const p of patients.slice(0, 20)) {
    for (let d = 0; d < 3; d++) {
      const n = ++seq.vs;
      nurse.prepare('INSERT INTO vital_sign VALUES (?,?,?,?,?,?,?,?)').run(
        id('VS', n), p.inhos, p.name, fmtDateTime(addDays(new Date(p.admit + 'T08:00:00'), d)), round1(36.2 + (p.idx % 10) / 10), 60 + (p.idx * 3 + d) % 40, `${110 + p.idx % 30}/${70 + p.idx % 15}`, NURSES[p.idx % 4]);
    }
  }
  // 院感 2 例 + 随访 5 例
  const infPatients = patients.filter((_, i) => i === 1 || i === 14);
  infPatients.forEach((p, k) => {
    const n = ++seq.inf;
    emr.prepare('INSERT INTO infection_report VALUES (?,?,?,?,?,?,?)').run(id('IR', n), p.inhos, p.name, k ? '下呼吸道感染' : '导管相关血流感染', k ? '肺炎克雷伯菌' : '金黄色葡萄球菌', fmtDateTime(addDays(new Date(p.admit + 'T08:00:00'), 3)), '已上报');
  });
  const fuPatients = patients.filter((_, i) => i % 8 === 2).slice(0, 5);
  fuPatients.forEach((p, k) => {
    const n = ++seq.fu;
    emr.prepare('INSERT INTO followup VALUES (?,?,?,?,?,?,?,?)').run(id('FU', n), p.inhos, p.name, ['出院随访', '慢病随访', '满意度回访'][k % 3], fmtDate(addDays(new Date(p.discharge || p.admit + 'T00:00:00'), 7)), k % 2 ? fmtDate(addDays(new Date(p.discharge || p.admit + 'T00:00:00'), 8)) : null, k % 2 ? '已完成' : '待随访', '出院后注意休息，按时服药');
  });
  // 输血 2 例
  const bloodPatients = [patients[5], patients[10]];
  bloodPatients.forEach((p, k) => {
    const n = ++seq.blood;
    his.prepare('INSERT INTO blood_apply VALUES (?,?,?,?,?,?,?,?)').run(id('BA', n), p.inhos, p.name, ['A型', 'O型'][k], '红细胞悬液', 2, fmtDateTime(addDays(new Date(p.admit + 'T08:00:00'), 1)), '已发血');
    his.prepare('INSERT INTO blood_transfusion VALUES (?,?,?,?,?,?,?)').run(id('BT', n), id('BA', n), p.inhos, `B2026${String(900 + n)}`, fmtDateTime(addDays(new Date(p.admit + 'T08:00:00'), 2)), NURSES[k], '无');
  });

  // ---------- 药房进销存 ----------
  let poSeq = 0, inSeq = 0, outSeq = 0;
  for (const d of DRUGS) {
    const n = ++poSeq;
    ph.prepare('INSERT INTO purchase_order VALUES (?,?,?,?,?,?,?,?)').run(id('PO', n), d[0], d[1], 1000, round2(10 + (n % 7) * 3), ['华东医药', '国药控股', '上药集团'][n % 3], '已入库', '2026-07-20 09:00:00');
    ph.prepare('INSERT INTO stock_in VALUES (?,?,?,?,?,?,?)').run(id('SI', ++inSeq), id('PO', n), d[0], d[1], 1000, '2026-07-25 09:00:00', '库管员');
  }
  const outByDrug = {};
  for (const r of ph.prepare('SELECT item_code, COUNT(*) c FROM dispense_record WHERE status IN (\'0\',\'1\') GROUP BY item_code').all()) outByDrug[r.item_code] = r.c * 3;
  for (const d of DRUGS) {
    const out = outByDrug[d[0]] || 0;
    if (out > 0) ph.prepare('INSERT INTO stock_out VALUES (?,?,?,?,?,?,?,?)').run(id('SO', ++outSeq), d[0], d[1], out, '发药出库', null, '2026-09-01 09:00:00', '库管员');
    ph.prepare('INSERT INTO drug_stock VALUES (?,?,?,?,?,?)').run(d[0], d[1], 1000 - out, '盒', '住院药房', T);
  }
  // 预埋一个低库存药品（LOW_STOCK_COUNT 巡检锚点）
  ph.prepare("UPDATE drug_stock SET quantity=40 WHERE drug_code='D012'");

  // ---------- 对账记录（15 天，全平） ----------
  for (let d = 0; d < 15; d++) {
    const day = fmtDate(addDays(new Date('2026-08-25T00:00:00'), d));
    const sys = 80000 + d * 1200;
    charge.prepare('INSERT INTO reconcile_record VALUES (?,?,?,?,?,?,?)').run(id('REC', d + 1), day, '扫码', sys, sys, 0, '平');
  }

  // ---------- 门诊 25 人 ----------
  const OPD_NAMES = ['何伟', '吕芳', '施建国', '张平', '孔令辉', '曹雪芹', '严浩翔', '华晨宇', '金巧巧', '魏璎珞', '陶勇', '姜文', '戚薇', '谢娜', '邹市明', '喻恩泰', '白敬亭', '水木年华', '窦唯', '章子怡', '米雪', '云千千', '苏有朋', '贾玲', '沈腾'];
  for (let i = 0; i < 25; i++) {
    const card = `OPD2026${String(1000 + i)}`;
    const dept = INP_DEPTS[i % 5], doctor = DOCTORS[i % 6];
    const regTime = fmtDateTime(addDays(new Date('2026-09-01T08:30:00'), i % 8));
    const refunded = i === 20;
    opd.prepare('INSERT INTO opd_reg VALUES (?,?,?,?,?,?,?,?)').run(id('RG', i + 1), card, OPD_NAMES[i], dept, doctor, 20, refunded ? '2' : '1', regTime);
    if (refunded) continue;
    const diag = DIAGS[[0, 3, 4, 13][i % 4]];
    opd.prepare('INSERT INTO opd_visit VALUES (?,?,?,?,?,?)').run(id('OV', i + 1), card, diag[1], regTime, doctor, '2');
    const drug = DRUGS[i % 12];
    const prescStatus = i === 8 ? '0' : (i % 6 === 4 ? '1' : '3'); // 1 张作废已退费、偶发未缴费
    opd.prepare('INSERT INTO opd_presc VALUES (?,?,?,?,?,?,?,?,?,?)').run(id('OP', i + 1), id('OV', i + 1), card, drug[0], drug[1], '药品', 2, round2(20 + i), prescStatus, regTime);
    if (prescStatus === '3') {
      opd.prepare('INSERT INTO opd_presc VALUES (?,?,?,?,?,?,?,?,?,?)').run(id('OPX', i + 1), id('OV', i + 1), card, 'L001', '血常规', '检验', 1, 25, '3', regTime);
    }
  }

  // ---------- 物资进销存 ----------
  const MATERIALS = [['M001', '一次性输液器', '标准型', '支'], ['M002', '一次性注射器', '5ml', '支'], ['M003', '医用口罩', '外科', '只'], ['M004', '医用纱布', '灭菌', '包'], ['M005', '留置针', '24G', '支'], ['M006', '引流袋', '抗反流', '个'], ['M007', '雾化器面罩', '儿童型', '个'], ['M008', '血压计袖带', '成人', '条']];
  let minSeq = 0, moutSeq = 0, mapplySeq = 0;
  const outByMat = {};
  for (let i = 0; i < 10; i++) {
    const m = MATERIALS[i % 8];
    const dept = INP_DEPTS[i % 5];
    const qty = 20 + (i % 4) * 10;
    const n = ++mapplySeq;
    mat.prepare('INSERT INTO material_apply VALUES (?,?,?,?,?,?,?,?)').run(id('MA', n), m[0], m[1], qty, dept, fmtDateTime(addDays(new Date('2026-08-20T09:00:00'), i)), '已发', NURSES[i % 4]);
    mat.prepare('INSERT INTO material_out VALUES (?,?,?,?,?,?,?,?)').run(id('MO2', ++moutSeq), id('MA', n), m[0], m[1], qty, dept, fmtDateTime(addDays(new Date('2026-08-20T09:00:00'), i)), NURSES[i % 4]);
    outByMat[m[0]] = (outByMat[m[0]] || 0) + qty;
  }
  for (const m of MATERIALS) {
    mat.prepare('INSERT INTO material_in VALUES (?,?,?,?,?,?)').run(id('MI', ++minSeq), m[0], m[1], 500, '2026-08-01 09:00:00', '库管员');
    mat.prepare('INSERT INTO material_stock VALUES (?,?,?,?,?,?,?)').run(m[0], m[1], m[2], 500 - (outByMat[m[0]] || 0), m[3], '中心库房', T);
  }

  closeAll([his, lis, charge, ph, opd, emr, pacs, nurse, mat]);
  return true;
}
function cancelTime(at) { return at; }
function round2(x) { return Math.round(x * 100) / 100; }
function round1(x) { return Math.round(x * 10) / 10; }
function closeAll(dbs) { for (const d of dbs) d.close(); }

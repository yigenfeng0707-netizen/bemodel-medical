import { platform, now, businessDb } from '../db.js';
import { encryptSecret } from '../common.js';
import { config } from '../config.js';

// =====================================================================
// 平台种子数据（对应原版 V1/V3~V25/V34/V37/V41/V43 种子迁移 + DataSeeder 本体部分）
// =====================================================================

const DOMAINS = [
  ['PATIENT_DOMAIN', '患者域', '患者主索引与人口学信息', 1],
  ['CLINICAL', '临床域', '就诊、医嘱、诊断等临床业务概念', 2],
  ['MEDTECH', '医技域', '检验检查申请与报告', 3],
  ['FEE', '费用域', '计费、结算、退费、发票', 4],
  ['OPS', '运营域', '运营与系统运维概念', 5],
  ['PHARMACY', '药学域', '调剂、库存、审方', 6],
  ['NURSING', '护理域', '护理执行与计划', 7],
  ['SURGERY', '手术麻醉域', '手术与麻醉记录', 8],
  ['MEDRECORD', '病案域', '病案文书与 DRG', 9],
  ['INSURANCE', '医保域', '医保结算相关', 10],
  ['BLOOD', '输血域', '用血申请与输血闭环', 11],
  ['INFECTION', '院感域', '院感上报与核实', 12],
  ['APPOINTMENT', '预约域', '预约挂号', 13],
  ['FOLLOWUP', '随访域', '出院随访与满意度', 14],
  ['MATERIAL', '物资耗材域', '物资申领与出入库', 15],
  ['ORG', '人事组织域', '科室与人员主数据', 16],
];

// 概念定义：[code, name, domain, definition, owner, attrs[[attrCode, attrName, dataType, isKey, def]]]
const N = 'STRING';
const CONCEPTS = [
  ['PATIENT', '患者', 'PATIENT_DOMAIN', '在全院范围内唯一标识的自然人患者主索引', '信息科', [
    ['inhos_no', '住院号', N, 1, '患者住院唯一标识'], ['patient_name', '患者姓名', N, 0, ''], ['sex', '性别', N, 0, ''], ['age', '年龄', 'NUMBER', 0, '']]],
  ['INP_VISIT', '住院就诊', 'CLINICAL', '一次住院行为，一码（住院号）一就诊', '医务处', [
    ['inhos_no', '住院号', N, 1, ''], ['admit_time', '入院时间', 'DATE', 0, ''], ['discharge_time', '出院时间', 'DATE', 0, ''], ['status', '就诊状态', N, 0, '在院/出院'], ['dept', '出院科室', N, 0, ''], ['ward', '病区', N, 0, ''], ['doctor', '主管医生', N, 0, '']]],
  ['OPD_VISIT', '门诊就诊', 'CLINICAL', '一次门诊接诊行为', '医务处', [
    ['visit_id', '就诊ID', N, 1, ''], ['card_no', '就诊卡号', N, 1, ''], ['diag', '诊断', N, 0, ''], ['doctor', '接诊医生', N, 0, ''], ['status', '接诊状态', N, 0, '']]],
  ['REGISTER', '门诊挂号', 'APPOINTMENT', '门诊挂号行为，缴费后生成门诊就诊', '门诊部', [
    ['reg_id', '挂号单号', N, 1, ''], ['pat_card_no', '就诊卡号', N, 0, ''], ['reg_dept', '挂号科室', N, 0, ''], ['reg_fee', '挂号费', 'NUMBER', 0, ''], ['reg_status', '挂号状态', N, 0, '1已挂号/2已退号']]],
  ['MEDICAL_ORDER', '医嘱', 'CLINICAL', '医生下达的医疗指令，检验/检查/药品三类', '医务处', [
    ['order_id', '医嘱号', N, 1, ''], ['inhos_no', '住院号', N, 0, ''], ['item_code', '项目编码', N, 0, ''], ['item_name', '项目名称', N, 0, ''], ['order_type', '医嘱类型', N, 0, '检验/检查/药品'], ['order_status', '医嘱状态', N, 0, '0未执行/1已执行/2已取消'], ['order_time', '开立时间', 'DATE', 0, ''], ['cancel_time', '取消时间', 'DATE', 0, ''], ['doctor', '开单医生', N, 0, ''], ['single_dose', '单次剂量', 'NUMBER', 0, ''], ['dose_unit', '剂量单位', N, 0, ''], ['frequency', '频次', N, 0, 'qd/bid/tid/q8h']]],
  ['DIAGNOSIS', '诊断', 'CLINICAL', '经标准编码化的临床诊断', '医务处', [
    ['diag_code', '诊断编码', N, 1, '平台诊断字典编码'], ['diag_name', '诊断名称', N, 0, ''], ['icd10', 'ICD-10编码', N, 0, ''], ['snomed_code', 'SNOMED CT编码', N, 0, '']]],
  ['PROCEDURE', '手术操作', 'SURGERY', '标准化的手术操作记录', '医务处', [
    ['surg_id', '手术ID', N, 1, ''], ['proc_name', '手术名称', N, 0, ''], ['proc_level', '手术级别', N, 0, '一/二/三级'], ['surgeon', '术者', N, 0, '']]],
  ['ANESTHESIA_RECORD', '麻醉记录', 'SURGERY', '手术的麻醉实施记录', '麻醉科', [
    ['anes_id', '麻醉记录ID', N, 1, ''], ['surg_id', '手术ID', N, 0, ''], ['method', '麻醉方式', N, 0, ''], ['anesthetist', '麻醉医师', N, 0, '']]],
  ['PREGNANCY', '妊娠', 'CLINICAL', '妊娠状态小概念，与男性患者互斥（AX-003 专用）', '医务处', [
    ['preg_no', '妊娠记录号', N, 1, '']]],
  ['EMR_RECORD', '病案记录', 'MEDRECORD', '住院病案文书（首页/入院记录/出院小结）', '病案室', [
    ['record_id', '病案ID', N, 1, ''], ['inhos_no', '住院号', N, 0, ''], ['record_type', '病案类型', N, 0, ''], ['diag_main', '主要诊断', N, 0, ''], ['diag_list', '全部诊断', N, 0, '逗号分隔'], ['qc_status', '质控状态', N, 0, '未质控/通过/不通过']]],
  ['DRG_GROUP', 'DRG入组', 'MEDRECORD', '病案 DRG 分组结果', '病案室', [
    ['drg_id', '入组ID', N, 1, ''], ['drg_code', 'DRG编码', N, 0, ''], ['drg_name', 'DRG名称', N, 0, ''], ['weight', '权重', 'NUMBER', 0, '']]],
  ['PATIENT_ALLERGY', '患者过敏', 'CLINICAL', '患者过敏原记录，与药品过敏原互斥（AX-007）', '药学部', [
    ['inhos_no', '住院号', N, 1, ''], ['allergen', '过敏原', N, 0, ''], ['severity', '严重程度', N, 0, '一般/严重']]],
  ['LAB_APPLY', '检验申请', 'MEDTECH', '检验医嘱在 LIS 的执行申请', '检验科', [
    ['apply_id', '申请单号', N, 1, ''], ['order_id', '医嘱号', N, 0, ''], ['patient_no', '患者编号', N, 0, 'LIS 存住院号（口径差异）'], ['item_code', '项目编码', N, 0, ''], ['apply_status', '申请状态', N, 0, 'N已采样/P已发布/C已撤销(v5.2)/X旧码']]],
  ['LAB_REPORT', '检验报告', 'MEDTECH', '检验申请产出的结果报告', '检验科', [
    ['report_id', '报告ID', N, 1, ''], ['apply_id', '申请单号', N, 0, ''], ['result_status', '结果状态', N, 0, 'N正常/A异常'], ['reporter', '报告人', N, 0, '']]],
  ['CHECK_REPORT', '检查报告', 'MEDTECH', '影像/功能检查报告', '影像科', [
    ['exam_id', '报告ID', N, 1, ''], ['order_id', '医嘱号', N, 0, ''], ['abnormal_flag', '异常标志', N, 0, 'Y/N'], ['conclusion', '检查结论', N, 0, '']]],
  ['FEE_DETAIL', '费用明细', 'FEE', '医嘱执行产生的计费流水', '收费处', [
    ['fee_id', '费用流水号', N, 1, ''], ['order_id', '医嘱号', N, 0, ''], ['inhos_no', '住院号', N, 0, ''], ['amount', '金额', 'NUMBER', 0, ''], ['fee_status', '费用状态', N, 0, '1正常/2已退费'], ['charge_time', '计费时间', 'DATE', 0, '']]],
  ['SETTLEMENT', '结算记录', 'FEE', '一单一患者一次住院的结算单（口径：一单一患者一次住院）', '收费处', [
    ['settle_id', '结算单号', N, 1, ''], ['inhos_no', '住院号', N, 0, ''], ['total_amount', '结算总额', 'NUMBER', 0, ''], ['settle_status', '结算状态', N, 0, '1已结算/2已冲红'], ['settle_time', '结算时间', 'DATE', 0, '']]],
  ['PAYMENT', '缴费记录', 'FEE', '患者缴费流水（预交金/补缴/退费/门诊）', '收费处', [
    ['pay_id', '缴费流水号', N, 1, ''], ['inhos_no', '住院号', N, 0, ''], ['amount', '金额', 'NUMBER', 0, ''], ['pay_type', '缴费类型', N, 0, '1预交金/2结算补缴/3退费/4门诊缴费'], ['channel', '渠道', N, 0, '现金/扫码/医保']]],
  ['REFUND', '退费申请', 'FEE', '费用退回的申请与审批记录', '收费处', [
    ['refund_id', '退费单号', N, 1, ''], ['fee_id', '费用流水号', N, 0, ''], ['amount', '退费金额', 'NUMBER', 0, ''], ['status', '退费状态', N, 0, '1待审/2已退/3驳回']]],
  ['INVOICE', '发票', 'FEE', '结算对应的电子发票', '收费处', [
    ['invoice_id', '发票号', N, 1, ''], ['settle_id', '结算单号', N, 0, ''], ['amount', '金额', 'NUMBER', 0, ''], ['status', '发票状态', N, 0, '已开/作废']]],
  ['RECONCILE', '日对账', 'FEE', '收费系统与渠道方的日终对账', '收费处', [
    ['rec_id', '对账ID', N, 1, ''], ['channel', '渠道', N, 0, ''], ['diff', '差额', 'NUMBER', 0, ''], ['status', '对账结果', N, 0, '平/不平']]],
  ['DISPENSE', '发药记录', 'PHARMACY', '药房调剂发药/退药的执行记录', '药学部', [
    ['dispense_id', '发药单号', N, 1, ''], ['order_id', '医嘱号', N, 0, ''], ['item_code', '药品编码', N, 0, ''], ['status', '发药状态', N, 0, '0已调剂/1已发药/2已退药'], ['pharmacist', '药师', N, 0, '']]],
  ['DRUG_STOCK', '药品库存', 'PHARMACY', '药品实时库存', '药学部', [
    ['drug_code', '药品编码', N, 1, ''], ['quantity', '库存数量', 'NUMBER', 0, ''], ['warehouse', '仓库', N, 0, '']]],
  ['DRUG_PURCHASE', '采购单', 'PHARMACY', '药品采购订单', '药学部', [
    ['po_id', '采购单号', N, 1, ''], ['quantity', '采购数量', 'NUMBER', 0, ''], ['status', '采购状态', N, 0, '在途/已入库']]],
  ['STOCK_IN', '入库单', 'PHARMACY', '采购到货入库记录', '药学部', [
    ['in_id', '入库单号', N, 1, ''], ['quantity', '入库数量', 'NUMBER', 0, '']]],
  ['STOCK_OUT', '出库单', 'PHARMACY', '发药/调拨/报损出库记录', '药学部', [
    ['out_id', '出库单号', N, 1, ''], ['quantity', '出库数量', 'NUMBER', 0, ''], ['out_type', '出库类型', N, 0, '发药/调拨/报损']]],
  ['PRESC_REVIEW', '处方审核', 'PHARMACY', '药师对药品医嘱的审核记录', '药学部', [
    ['review_id', '审核ID', N, 1, ''], ['review_result', '审核结论', N, 0, '通过/驳回'], ['reject_reason', '驳回原因', N, 0, '']]],
  ['NURSE_EXEC', '护士执行', 'NURSING', '护士站医嘱执行确认记录', '护理部', [
    ['exec_id', '执行ID', N, 1, ''], ['order_id', '医嘱号', N, 0, ''], ['exec_type', '执行类型', N, 0, '给药/采样/检查陪送/治疗'], ['exec_status', '执行状态', N, 0, '1已执行/0未执行'], ['nurse', '护士', N, 0, '']]],
  ['NURSING_PLAN', '护理计划', 'NURSING', '住院期间的护理计划文书', '护理部', [
    ['plan_id', '计划ID', N, 1, ''], ['inhos_no', '住院号', N, 0, '']]],
  ['VITAL_SIGN', '生命体征', 'NURSING', '体温脉搏血压等体征记录', '护理部', [
    ['vs_id', '体征ID', N, 1, ''], ['temperature', '体温', 'NUMBER', 0, ''], ['pulse', '脉搏', 'NUMBER', 0, ''], ['bp', '血压', N, 0, '']]],
  ['BLOOD_APPLY', '用血申请', 'BLOOD', '临床用血申请单', '输血科', [
    ['apply_id', '申请单号', N, 1, ''], ['blood_type', '血型', N, 0, ''], ['component', '血液成分', N, 0, ''], ['status', '申请状态', N, 0, '已申请/已配血/已发血']]],
  ['BLOOD_TRANSFUSION', '输血记录', 'BLOOD', '血袋发放与输注记录', '输血科', [
    ['trans_id', '输血ID', N, 1, ''], ['blood_no', '血袋号', N, 0, ''], ['reaction', '输血反应', N, 0, '']]],
  ['INFECTION_REPORT', '院感报告', 'INFECTION', '医院感染上报与核实', '院感科', [
    ['report_id', '报告ID', N, 1, ''], ['infection_type', '感染类型', N, 0, ''], ['pathogen', '病原体', N, 0, ''], ['status', '上报状态', N, 0, '已上报/已核实/已结案']]],
  ['FOLLOWUP', '随访记录', 'FOLLOWUP', '出院/慢病/满意度随访', '医务处', [
    ['fu_id', '随访ID', N, 1, ''], ['fu_type', '随访类型', N, 0, ''], ['status', '随访状态', N, 0, '待随访/已完成']]],
  ['MATERIAL_STOCK', '物资库存', 'MATERIAL', '耗材物资实时库存', '设备科', [
    ['material_code', '物资编码', N, 1, ''], ['quantity', '库存数量', 'NUMBER', 0, ''], ['warehouse', '仓库', N, 0, '']]],
  ['MATERIAL_APPLY', '物资申领', 'MATERIAL', '科室物资申领单', '设备科', [
    ['apply_id', '申领单号', N, 1, ''], ['quantity', '申领数量', 'NUMBER', 0, ''], ['status', '申领状态', N, 0, '待发/已发']]],
  ['MATERIAL_IN', '物资入库', 'MATERIAL', '物资采购入库记录', '设备科', [
    ['in_id', '入库单号', N, 1, ''], ['quantity', '入库数量', 'NUMBER', 0, '']]],
  ['MATERIAL_OUT', '物资出库', 'MATERIAL', '物资发放出库记录', '设备科', [
    ['out_id', '出库单号', N, 1, ''], ['quantity', '出库数量', 'NUMBER', 0, '']]],
  ['DEPT', '科室', 'ORG', '科室主数据', '人事科', [
    ['dept_code', '科室编码', N, 1, ''], ['dept_name', '科室名称', N, 0, ''], ['category', '科室类别', N, 0, '临床/医技/职能'], ['bed_count', '床位数', 'NUMBER', 0, '']]],
  ['STAFF', '人员', 'ORG', '职工主数据', '人事科', [
    ['staff_id', '工号', N, 1, ''], ['staff_name', '姓名', N, 0, ''], ['role', '岗位角色', N, 0, ''], ['title', '职称', N, 0, ''], ['dept_code', '科室编码', N, 0, '']]],
  ['SYS_CHANGE', '系统变更', 'OPS', '业务系统的版本变更记录', '信息科', [
    ['change_id', '变更单号', N, 1, ''], ['change_desc', '变更说明', N, 0, '']]],
  ['DATA_ISSUE', '数据问题', 'OPS', '跨系统数据一致性问题的登记', '信息科', [
    ['issue_id', '问题编号', N, 1, ''], ['issue_desc', '问题描述', N, 0, '']]],
  ['CLINICAL_FINDING', '临床所见', 'CLINICAL', '诊断/报告类概念的伞概念（subClassOf 根）', '医务处', [
    ['finding_id', '所见ID', N, 1, '']]],
  ['ALLERGEN_CEPHALOSPORIN', '头孢菌素类过敏', 'PHARMACY', '头孢类过敏原词族小概念（AX-007 专用）', '药学部', [
    ['allergen_id', '过敏原ID', N, 1, '']]],
];

// 关系：[from, to, name, description, axiomFlags{sym,trans,func,invFunc,asym}, inverseOf]
const RELATIONS = [
  ['PATIENT', 'INP_VISIT', '发生就诊', '一名患者可多次住院', { invFunc: 1 }, null],
  ['PATIENT', 'OPD_VISIT', '门诊就诊', '一名患者多次门诊', {}, null],
  ['REGISTER', 'OPD_VISIT', '生成', '挂号缴费后生成门诊就诊', {}, null],
  ['OPD_VISIT', 'MEDICAL_ORDER', '开立处方', '门诊就诊开立处方医嘱', {}, null],
  ['INP_VISIT', 'MEDICAL_ORDER', '下达', '住院期间下达医嘱', {}, null],
  ['MEDICAL_ORDER', 'LAB_APPLY', '生成申请', '检验医嘱生成检验申请', {}, null],
  ['LAB_APPLY', 'LAB_REPORT', '生成报告', '检验申请产出报告', {}, null],
  ['MEDICAL_ORDER', 'CHECK_REPORT', '产生报告', '检查医嘱产出检查报告', {}, null],
  ['MEDICAL_ORDER', 'FEE_DETAIL', '产生费用', '医嘱执行产生计费；执行必产生费用、取消必联动退费（AX-005）', { asym: 1 }, null],
  ['FEE_DETAIL', 'SETTLEMENT', '汇总入', '费用明细汇总进结算单', {}, null],
  ['INP_VISIT', 'SETTLEMENT', '出院结算', '一次就诊至多一张有效结算单', { func: 1 }, null],
  ['INP_VISIT', 'PAYMENT', '缴纳', '住院期间预交金与补缴', {}, null],
  ['INP_VISIT', 'EMR_RECORD', '形成', '就诊形成病案文书', {}, null],
  ['INP_VISIT', 'DIAGNOSIS', '确诊', '就诊得出诊断', {}, null],
  ['DIAGNOSIS', 'PROCEDURE', '指导', '诊断指导手术指征（AX-002）', {}, null],
  ['LAB_REPORT', 'DIAGNOSIS', '支撑', '检验结果支撑诊断依据（AX-004）', {}, null],
  ['MEDICAL_ORDER', 'DISPENSE', '调剂发药', '药品医嘱经药房调剂发药', {}, null],
  ['MEDICAL_ORDER', 'PRESC_REVIEW', '审方', '药品医嘱经药师审核', {}, null],
  ['INP_VISIT', 'VITAL_SIGN', '记录体征', '住院期间记录生命体征', {}, null],
  ['INP_VISIT', 'BLOOD_APPLY', '用血申请', '住院期间临床用血申请', {}, null],
  ['BLOOD_APPLY', 'BLOOD_TRANSFUSION', '执行输血', '用血申请执行为输血记录', {}, null],
  ['INP_VISIT', 'FOLLOWUP', '随访', '出院后随访', {}, null],
  ['PROCEDURE', 'ANESTHESIA_RECORD', '麻醉记录', '手术实施麻醉并记录', {}, null],
  ['EMR_RECORD', 'DRG_GROUP', '入组', '病案进行 DRG 分组', {}, null],
  ['INP_VISIT', 'NURSE_EXEC', '执行确认', '护士站执行医嘱', {}, null],
  ['DRUG_PURCHASE', 'STOCK_IN', '入库', '采购到货入库', {}, null],
  ['STOCK_IN', 'DRUG_STOCK', '补充', '入库增加库存', {}, null],
  ['STOCK_OUT', 'DRUG_STOCK', '扣减', '出库减少库存', {}, null],
  ['MATERIAL_IN', 'MATERIAL_STOCK', '补充', '物资入库增加库存', {}, null],
  ['MATERIAL_OUT', 'MATERIAL_STOCK', '扣减', '物资出库减少库存', {}, null],
  ['MATERIAL_APPLY', 'MATERIAL_OUT', '发放', '申领单发放出库', {}, null],
  ['DEPT', 'STAFF', '拥有人员', '科室拥有职工', {}, '所属科室'],
  ['STAFF', 'DEPT', '所属科室', '职工归属科室', {}, '拥有人员'],
  ['STAFF', 'STAFF', '同事', '同一科室互为同事（自环对称）', { sym: 1 }, null],
  ['NURSE_EXEC', 'NURSING_PLAN', '属于', '执行记录归属护理计划（传递链第1跳）', { trans: 1 }, null],
  ['NURSING_PLAN', 'EMR_RECORD', '属于', '护理计划归属病案（传递链第2跳）', { trans: 1 }, null],
  ['VITAL_SIGN', 'EMR_RECORD', '属于', '体征记录归属病案（传递链）', { trans: 1 }, null],
  ['INFECTION_REPORT', 'EMR_RECORD', '属于', '院感报告归属病案（传递链）', { trans: 1 }, null],
];

// 多父继承（V24）：[child, parent, isPrimary]
const PARENTS = [
  ['DIAGNOSIS', 'CLINICAL_FINDING', 1], ['LAB_REPORT', 'CLINICAL_FINDING', 1],
  ['CHECK_REPORT', 'CLINICAL_FINDING', 1], ['INFECTION_REPORT', 'CLINICAL_FINDING', 1],
  ['PREGNANCY', 'DIAGNOSIS', 1], ['INFECTION_REPORT', 'EMR_RECORD', 0], // 演示多父
];

// 互斥（V19/V22）
const DISJOINTS = [
  ['PREGNANCY', 'PATIENT', '妊娠状态与男性患者互斥（AX-003）'],
];

// SPO 公理（V8/V13）
const AXIOMS = [
  ['AX-001', '并发症', '依赖', '原发诊断', '并发症诊断必须关联原发诊断'],
  ['AX-002', '手术', '因果', '诊断', '手术须有诊断指征'],
  ['AX-003', '妊娠/妇科诊断', '互斥', '男性患者', '妊娠及妇科诊断与男性患者互斥'],
  ['AX-004', '检验报告', '支撑', '诊断', '异常检验报告须有临床处置'],
  ['AX-005', '医嘱', '存在性', '费用明细', '医嘱执行必产生费用、取消必联动退费'],
  ['AX-006', '并发症', '继承', '诊断', '并发症是诊断的子类'],
  ['AX-007', '药品', '互斥', '患者过敏原', '含患者过敏原的药品禁开（过敏禁忌）'],
  ['AX-008', '药品医嘱', '约束', '日最大剂量', '单日剂量不得超过药品日最大剂量'],
  ['AX-009', '药品', '互斥', '相互作用药品', '相互作用的药品不得同时医嘱'],
];

// 术语：[term, conceptCode, sourceProduct, type, codeSystem, stdCode]
const TERMS = [
  ['患者', 'PATIENT', '平台标准', 'STANDARD', '平台标准', null],
  ['病员', 'PATIENT', 'HIS', 'ALIAS', null, null],
  ['病人', 'PATIENT', '门诊系统', 'ALIAS', null, null],
  ['受检者', 'PATIENT', 'LIS', 'ALIAS', null, null],
  ['住院号', 'PATIENT', '平台标准', 'STANDARD', '平台标准', null],
  ['病员号', 'PATIENT', 'HIS', 'ALIAS', null, null],
  ['患者编号', 'PATIENT', 'LIS', 'ALIAS', null, null],
  ['医嘱', 'MEDICAL_ORDER', '平台标准', 'STANDARD', '平台标准', null],
  ['化验单', 'LAB_APPLY', 'LIS', 'ALIAS', null, null],
  ['检验申请', 'LAB_APPLY', '平台标准', 'STANDARD', '平台标准', null],
  ['费用流水', 'FEE_DETAIL', 'HIS', 'ALIAS', null, null],
  ['高血压', 'DIAGNOSIS', '平台标准', 'STANDARD', 'SNOMED CT', '38341003'],
  ['2型糖尿病', 'DIAGNOSIS', '平台标准', 'STANDARD', 'SNOMED CT', '44054006'],
  ['肺炎', 'DIAGNOSIS', '平台标准', 'STANDARD', 'SNOMED CT', '233604007'],
  ['上呼吸道感染', 'DIAGNOSIS', '平台标准', 'STANDARD', 'SNOMED CT', '54150009'],
  ['急性胃肠炎', 'DIAGNOSIS', '平台标准', 'STANDARD', 'SNOMED CT', '40956001'],
  ['肺部感染', 'DIAGNOSIS', '平台标准', 'STANDARD', 'ICD-10', 'J98.4'],
  ['骨折', 'DIAGNOSIS', '平台标准', 'STANDARD', 'ICD-10', 'S82'],
  ['妊娠', 'PREGNANCY', '平台标准', 'STANDARD', 'ICD-10', 'Z34.9'],
  ['怀孕', 'PREGNANCY', '门诊系统', 'ALIAS', null, null],
  ['Gestation', 'PREGNANCY', 'LIS', 'ALIAS', null, null],
  ['头孢菌素', 'ALLERGEN_CEPHALOSPORIN', '平台标准', 'STANDARD', null, null],
  ['头孢', 'ALLERGEN_CEPHALOSPORIN', '门诊系统', 'ALIAS', null, null],
  ['先锋霉素', 'ALLERGEN_CEPHALOSPORIN', 'HIS', 'ALIAS', null, null],
  ['审方', 'PRESC_REVIEW', '药房系统', 'ALIAS', null, null],
  ['轧账', 'RECONCILE', '收费结算', 'ALIAS', null, null],
];

// 指标：[code, name, definition, formula, concept, owner, ds, probeSql, threshold]
const METRICS = [
  ['CANCEL_NOT_REFUND', '取消未退费笔数', '医嘱已取消但仍正常计费未退费的笔数（计费一致性核心指标，正常应为 0）', 'COUNT(取消医嘱 ∧ 费用正常)', 'FEE_DETAIL', '收费处', 'DS_HIS',
    "SELECT COUNT(*) FROM fee_detail f JOIN medical_order o ON f.order_id = o.order_id WHERE o.order_status = '2' AND f.fee_status = '1'", 0],
  ['DISCHARGE_COUNT', '出院人数', '统计期内办理出院结算的住院人数', 'COUNT(inpatient WHERE status=出院)', 'INP_VISIT', '医务处', 'DS_HIS',
    "SELECT COUNT(*) FROM inpatient WHERE status = '出院'", 0],
  ['LAB_CANCEL_RATE', '检验撤销率(‰)', '检验申请中撤销（含 v5.2 C 码与 v5.1 X 旧码）占比，千分比', 'SUM(撤销申请)/COUNT(全部申请)×1000', 'LAB_APPLY', '检验科', 'DS_LIS',
    "SELECT CAST(1000.0 * SUM(CASE WHEN apply_status IN ('C','X') THEN 1 ELSE 0 END) / COUNT(*) AS INTEGER) FROM lab_apply", 100],
  ['AVG_INP_FEE', '出院均次费用', '出院患者结算总额均值（元）', 'AVG(settlement.total_amount)', 'SETTLEMENT', '收费处', 'DS_CHARGE',
    'SELECT CAST(AVG(total_amount) AS INTEGER) FROM settlement', 20000],
  ['SETTLE_COUNT', '结算单笔数', '结算记录总笔数（对账组口径之一）', 'COUNT(settlement)', 'SETTLEMENT', '收费处', 'DS_CHARGE',
    'SELECT COUNT(*) FROM settlement', 0],
  ['LOW_STOCK_COUNT', '低库存药品数', '库存≤50 的药品种数', 'COUNT(drug_stock WHERE quantity≤50)', 'DRUG_STOCK', '药学部', 'DS_PHARMACY',
    'SELECT COUNT(*) FROM drug_stock WHERE quantity <= 50', 0],
  ['STOCK_TURNOVER', '库存周转率(‰)', '出库总量/入库总量×1000', 'SUM(stock_out)/SUM(stock_in)×1000', 'DRUG_STOCK', '药学部', 'DS_PHARMACY',
    'SELECT CAST(1000.0 * (SELECT COALESCE(SUM(quantity),0) FROM stock_out) / (SELECT MAX(1, COALESCE(SUM(quantity),1)) FROM stock_in) AS INTEGER) FROM stock_in', 500],
];

// 规则：[code, name, concept, type, expression, metricCode, severity, owner, engine, exprJson]
const RULES = [
  ['RULE-FEE-001', '取消医嘱不得计费', 'FEE_DETAIL', '校验', '医嘱状态为已取消时，其费用明细不得处于正常计费状态', 'CANCEL_NOT_REFUND', '高', '收费处', null, null],
  ['RULE-FEE-002', '检验撤销必须退费', 'FEE_DETAIL', '约束', '检验申请撤销后，对应费用必须完成退费', 'CANCEL_NOT_REFUND', '高', '收费处', null, null],
  ['RULE-LAB-001', '已发布申请必有报告', 'LAB_REPORT', '校验', '状态为已发布的检验申请必须存在对应检验报告', null, '中', '检验科', null, null],
  ['RULE-PHARM-001', '先退药后退费', 'DISPENSE', '约束', '药品退费前必须先完成退药', null, '中', '药学部', null, null],
  ['RULE-SETTLE-001', '结算总额推导口径', 'SETTLEMENT', '校验', '结算总额应等于其费用明细金额之和', null, '中', '收费处', null, null],
  ['RULE-OPD-001', '门诊先缴费后执行', 'OPD_VISIT', '约束', '门诊处方执行前必须完成缴费', null, '中', '门诊部', null, null],
  ['RULE-QC-001', '诊断依据完整', 'EMR_RECORD', '校验', '主要诊断必须有配套检验/检查依据', null, '高', '病案质控', 'QC', JSON.stringify({ type: 'DIAG_REQUIRES_ITEM', diagKeywords: ['糖尿病', '肺炎', '冠心病', '胃肠炎', '哮喘'], itemCodes: ['L001', 'L002', 'L003', 'L005', 'L006', 'E001', 'E002'] })],
  ['RULE-QC-002', '术前必备检查', 'EMR_RECORD', '校验', '有手术记录的病案术前必须有凝血四项检验', null, '高', '病案质控', 'QC', JSON.stringify({ type: 'PREOP_REQUIRES', itemCodes: ['L004'] })],
  ['RULE-QC-003', '异常须处置', 'EMR_RECORD', '校验', '异常检验报告之后必须有处置（后续抗生素医嘱）', null, '高', '病案质控', 'QC', JSON.stringify({ type: 'ABNORMAL_REQUIRES_COVER', itemCodes: ['L006'], drugCodes: ['D003', 'D008', 'D011'] })],
  ['RULE-QC-004', '并发症处置', 'EMR_RECORD', '校验', '并发症诊断须有对应治疗用药', null, '中', '病案质控', 'QC', JSON.stringify({ type: 'COMPLICATION_REQUIRES_ITEM', complicationKeywords: ['胃肠炎'], drugCodes: ['D004', 'D010'] })],
  ['RULE-QC-005', '性别互斥诊断', 'EMR_RECORD', '校验', '男性患者不得出现卵巢等女性特有诊断（公理 AX-003）', null, '高', '病案质控', 'QC', JSON.stringify({ type: 'SEX_DISJOINT_DIAG', femaleDiagKeywords: ['卵巢', '子宫', '妊娠'] })],
  ['RULE-QC-006', '检查异常须处置', 'EMR_RECORD', '校验', '检查报告异常后必须有后续处置', null, '中', '病案质控', 'QC', JSON.stringify({ type: 'EXAM_ABNORMAL_REQUIRES_COVER', drugCodes: ['D003', 'D008', 'D011'] })],
];

// 动作：[code, name, concept, fromStatus, toStatus, trigger, description]
const ACTIONS = [
  ['ACT-ORDER-CREATE', '开立医嘱', 'MEDICAL_ORDER', null, '未执行', '医生开立', '医嘱生命起点'],
  ['ACT-ORDER-EXEC', '执行医嘱', 'MEDICAL_ORDER', '未执行', '已执行', '医嘱执行确认', '执行必产生费用'],
  ['ACT-ORDER-CANCEL', '取消医嘱', 'MEDICAL_ORDER', '未执行,已执行', '已取消', '医生取消', '取消必联动退费（AX-005）'],
  ['ACT-APPLY-CANCEL', '撤销检验申请', 'LAB_APPLY', '已采样,已发布', '已撤销', '检验撤销', 'v5.2 后状态码为 C（旧码 X）'],
  ['ACT-REPORT-PUBLISH', '发布报告', 'LAB_REPORT', null, '已发布', '检验科审核发布', ''],
  ['ACT-DISPENSE', '调剂发药', 'DISPENSE', '已调剂', '已发药', '药房发药', '缴费是发药前置'],
  ['ACT-RETURN-DRUG', '退药', 'DISPENSE', '已发药', '已退药', '患者退药', '先退药后退费'],
  ['ACT-SETTLE', '出院结算', 'SETTLEMENT', null, '已结算', '出院结算', '一单一患者一次住院'],
  ['ACT-REFUND', '发起退费', 'REFUND', null, '待审', '费用退回申请', '退费必须关联费用明细'],
];

// 治理规则（V12/V16）：[code, name, type, concept, severity, exprJson]
const GOV_RULES = [
  ['GOV-001', '医嘱主键唯一', 'PK_UNIQUE', 'MEDICAL_ORDER', '高', { type: 'PK_UNIQUE', ds: 'DS_HIS', table: 'medical_order', column: 'order_id' }],
  ['GOV-002', '患者主索引唯一', 'PK_UNIQUE', 'PATIENT', '高', { type: 'PK_UNIQUE', ds: 'DS_HIS', table: 'inpatient', column: 'inhos_no' }],
  ['GOV-003', '患者关键信息完整', 'NOT_NULL', 'PATIENT', '中', { type: 'NOT_NULL', ds: 'DS_HIS', table: 'inpatient', columns: ['inhos_no', 'patient_name', 'sex'] }],
  ['GOV-004', '检验状态字典跨库一致', 'DICT_CONSISTENT', 'LAB_APPLY', '高', { type: 'DICT_CONSISTENT', ds: 'DS_LIS', table: 'lab_apply', column: 'apply_status', dictDs: 'DS_HIS', dictTable: 'status_map', dictColumn: 'src_status', dictFilter: { src_system: 'LIS' } }],
  ['GOV-005', '费用必须关联医嘱', 'REF_INTACT', 'FEE_DETAIL', '高', { type: 'REF_INTACT', ds: 'DS_HIS', table: 'fee_detail', column: 'order_id', refDs: 'DS_HIS', refTable: 'medical_order', refColumn: 'order_id' }],
  ['GOV-006', '报告必须关联申请单', 'REF_INTACT', 'LAB_REPORT', '中', { type: 'REF_INTACT', ds: 'DS_LIS', table: 'lab_report', column: 'apply_id', refDs: 'DS_LIS', refTable: 'lab_apply', refColumn: 'apply_id' }],
  ['GOV-007', '药品库存账实相符', 'STOCK_BALANCE', 'DRUG_STOCK', '高', { type: 'STOCK_BALANCE', ds: 'DS_PHARMACY', stockTable: 'drug_stock', inTable: 'stock_in', outTable: 'stock_out', keyColumn: 'drug_code', qtyColumn: 'quantity' }],
  ['GOV-008', '发药必须关联医嘱', 'REF_INTACT', 'DISPENSE', '高', { type: 'REF_INTACT', ds: 'DS_PHARMACY', table: 'dispense_record', column: 'order_id', refDs: 'DS_HIS', refTable: 'medical_order', refColumn: 'order_id' }],
  ['GOV-009', '结算单一号一结', 'PK_UNIQUE', 'SETTLEMENT', '高', { type: 'PK_UNIQUE', ds: 'DS_CHARGE', table: 'settlement', column: 'settle_id' }],
  ['GOV-010', '审核记录必须关联医嘱', 'REF_INTACT', 'PRESC_REVIEW', '中', { type: 'REF_INTACT', ds: 'DS_PHARMACY', table: 'presc_review', column: 'order_id', refDs: 'DS_HIS', refTable: 'medical_order', refColumn: 'order_id' }],
  ['GOV-011', '物资库存账实相符', 'STOCK_BALANCE', 'MATERIAL_STOCK', '中', { type: 'STOCK_BALANCE', ds: 'DS_MATERIAL', stockTable: 'material_stock', inTable: 'material_in', outTable: 'material_out', keyColumn: 'material_code', qtyColumn: 'quantity' }],
  ['GOV-012', '发放必须关联申领', 'REF_INTACT', 'MATERIAL_OUT', '中', { type: 'REF_INTACT', ds: 'DS_MATERIAL', table: 'material_out', column: 'apply_id', refDs: 'DS_MATERIAL', refTable: 'material_apply', refColumn: 'apply_id' }],
];

// 数据源：[dsCode, dsName, product, fileKey]
const DATASOURCES = [
  ['DS_HIS', '住院HIS', 'HIS 住院医生站', 'bemodel_his'],
  ['DS_LIS', '检验系统', 'LIS', 'bemodel_lis'],
  ['DS_CHARGE', '收费结算', 'HIS 收费', 'bemodel_charge'],
  ['DS_PHARMACY', '药房系统', '药房调配', 'bemodel_pharmacy'],
  ['DS_OPD', '门诊系统', '门诊医生站', 'bemodel_opd'],
  ['DS_EMR', '电子病历', 'EMR', 'bemodel_emr'],
  ['DS_PACS', '影像系统', 'PACS/RIS', 'bemodel_pacs'],
  ['DS_NURSE', '护士站', '移动护理', 'bemodel_nurse'],
  ['DS_MATERIAL', '物资耗材', 'SPD 物资', 'bemodel_material'],
  ['DS_LAB', '实验沙盒', 'AI 对比实验室沙盒', 'bemodel_lab'],
];

// 映射：[ds, table, column, concept, attr, valueMap]
const M = (ds, table, column, concept, attr, vm) => [ds, table, column, concept, attr, vm || null];
const MAPPINGS = [
  M('DS_HIS', 'inpatient', 'inhos_no', 'PATIENT', 'inhos_no'), M('DS_HIS', 'inpatient', 'patient_name', 'PATIENT', 'patient_name'),
  M('DS_HIS', 'inpatient', 'sex', 'PATIENT', 'sex'), M('DS_HIS', 'inpatient', 'age', 'PATIENT', 'age'),
  M('DS_HIS', 'inpatient', 'inhos_no', 'INP_VISIT', 'inhos_no'), M('DS_HIS', 'inpatient', 'admit_time', 'INP_VISIT', 'admit_time'),
  M('DS_HIS', 'inpatient', 'discharge_time', 'INP_VISIT', 'discharge_time'), M('DS_HIS', 'inpatient', 'status', 'INP_VISIT', 'status', '{"在院":"在院","出院":"出院"}'),
  M('DS_HIS', 'inpatient', 'dept', 'INP_VISIT', 'dept'), M('DS_HIS', 'inpatient', 'ward', 'INP_VISIT', 'ward'), M('DS_HIS', 'inpatient', 'doctor', 'INP_VISIT', 'doctor'),
  M('DS_HIS', 'medical_order', 'order_id', 'MEDICAL_ORDER', 'order_id'), M('DS_HIS', 'medical_order', 'inhos_no', 'MEDICAL_ORDER', 'inhos_no'),
  M('DS_HIS', 'medical_order', 'item_code', 'MEDICAL_ORDER', 'item_code'), M('DS_HIS', 'medical_order', 'item_name', 'MEDICAL_ORDER', 'item_name'),
  M('DS_HIS', 'medical_order', 'order_type', 'MEDICAL_ORDER', 'order_type', '{"检验":"检验","检查":"检查","药品":"药品"}'),
  M('DS_HIS', 'medical_order', 'order_status', 'MEDICAL_ORDER', 'order_status', '{"0":"未执行","1":"已执行","2":"已取消"}'),
  M('DS_HIS', 'medical_order', 'create_time', 'MEDICAL_ORDER', 'order_time'), M('DS_HIS', 'medical_order', 'cancel_time', 'MEDICAL_ORDER', 'cancel_time'),
  M('DS_HIS', 'medical_order', 'doctor', 'MEDICAL_ORDER', 'doctor'), M('DS_HIS', 'medical_order', 'single_dose', 'MEDICAL_ORDER', 'single_dose'),
  M('DS_HIS', 'medical_order', 'dose_unit', 'MEDICAL_ORDER', 'dose_unit'), M('DS_HIS', 'medical_order', 'frequency', 'MEDICAL_ORDER', 'frequency'),
  M('DS_HIS', 'fee_detail', 'fee_id', 'FEE_DETAIL', 'fee_id'), M('DS_HIS', 'fee_detail', 'order_id', 'FEE_DETAIL', 'order_id'),
  M('DS_HIS', 'fee_detail', 'inhos_no', 'FEE_DETAIL', 'inhos_no'), M('DS_HIS', 'fee_detail', 'item_code', 'FEE_DETAIL', 'item_code'),
  M('DS_HIS', 'fee_detail', 'item_name', 'FEE_DETAIL', 'item_name'), M('DS_HIS', 'fee_detail', 'amount', 'FEE_DETAIL', 'amount'),
  M('DS_HIS', 'fee_detail', 'fee_status', 'FEE_DETAIL', 'fee_status', '{"1":"正常","2":"已退费"}'),
  M('DS_HIS', 'fee_detail', 'charge_time', 'FEE_DETAIL', 'charge_time'),
  M('DS_HIS', 'dept', 'dept_code', 'DEPT', 'dept_code'), M('DS_HIS', 'dept', 'dept_name', 'DEPT', 'dept_name'),
  M('DS_HIS', 'dept', 'category', 'DEPT', 'category'), M('DS_HIS', 'dept', 'bed_count', 'DEPT', 'bed_count'),
  M('DS_HIS', 'staff', 'staff_id', 'STAFF', 'staff_id'), M('DS_HIS', 'staff', 'staff_name', 'STAFF', 'staff_name'),
  M('DS_HIS', 'staff', 'role', 'STAFF', 'role'), M('DS_HIS', 'staff', 'title', 'STAFF', 'title'), M('DS_HIS', 'staff', 'dept_code', 'STAFF', 'dept_code'),
  M('DS_HIS', 'blood_apply', 'apply_id', 'BLOOD_APPLY', 'apply_id'), M('DS_HIS', 'blood_apply', 'blood_type', 'BLOOD_APPLY', 'blood_type'),
  M('DS_HIS', 'blood_apply', 'component', 'BLOOD_APPLY', 'component'), M('DS_HIS', 'blood_apply', 'status', 'BLOOD_APPLY', 'status'),
  M('DS_HIS', 'blood_transfusion', 'trans_id', 'BLOOD_TRANSFUSION', 'trans_id'), M('DS_HIS', 'blood_transfusion', 'blood_no', 'BLOOD_TRANSFUSION', 'blood_no'),
  M('DS_HIS', 'blood_transfusion', 'reaction', 'BLOOD_TRANSFUSION', 'reaction'),
  M('DS_LIS', 'lab_apply', 'apply_id', 'LAB_APPLY', 'apply_id'), M('DS_LIS', 'lab_apply', 'order_id', 'LAB_APPLY', 'order_id'),
  M('DS_LIS', 'lab_apply', 'patient_no', 'LAB_APPLY', 'patient_no'), M('DS_LIS', 'lab_apply', 'item_code', 'LAB_APPLY', 'item_code'),
  M('DS_LIS', 'lab_apply', 'apply_status', 'LAB_APPLY', 'apply_status', '{"N":"已采样","P":"已发布","C":"已撤销","X":"已撤销(v5.1旧码)"}'),
  M('DS_LIS', 'lab_report', 'report_id', 'LAB_REPORT', 'report_id'), M('DS_LIS', 'lab_report', 'apply_id', 'LAB_REPORT', 'apply_id'),
  M('DS_LIS', 'lab_report', 'result_status', 'LAB_REPORT', 'result_status', '{"N":"正常","A":"异常"}'),
  M('DS_CHARGE', 'settlement', 'settle_id', 'SETTLEMENT', 'settle_id'), M('DS_CHARGE', 'settlement', 'inhos_no', 'SETTLEMENT', 'inhos_no'),
  M('DS_CHARGE', 'settlement', 'total_amount', 'SETTLEMENT', 'total_amount'),
  M('DS_CHARGE', 'settlement', 'settle_status', 'SETTLEMENT', 'settle_status', '{"1":"已结算","2":"已冲红"}'),
  M('DS_CHARGE', 'pay_record', 'pay_id', 'PAYMENT', 'pay_id'), M('DS_CHARGE', 'pay_record', 'inhos_no', 'PAYMENT', 'inhos_no'),
  M('DS_CHARGE', 'pay_record', 'amount', 'PAYMENT', 'amount'),
  M('DS_CHARGE', 'pay_record', 'pay_type', 'PAYMENT', 'pay_type', '{"1":"预交金","2":"结算补缴","3":"退费","4":"门诊缴费"}'),
  M('DS_CHARGE', 'pay_record', 'channel', 'PAYMENT', 'channel'),
  M('DS_CHARGE', 'refund_apply', 'refund_id', 'REFUND', 'refund_id'), M('DS_CHARGE', 'refund_apply', 'fee_id', 'REFUND', 'fee_id'),
  M('DS_CHARGE', 'refund_apply', 'amount', 'REFUND', 'amount'), M('DS_CHARGE', 'refund_apply', 'status', 'REFUND', 'status', '{"1":"待审","2":"已退","3":"驳回"}'),
  M('DS_CHARGE', 'invoice', 'invoice_id', 'INVOICE', 'invoice_id'), M('DS_CHARGE', 'invoice', 'settle_id', 'INVOICE', 'settle_id'),
  M('DS_CHARGE', 'invoice', 'amount', 'INVOICE', 'amount'), M('DS_CHARGE', 'invoice', 'status', 'INVOICE', 'status'),
  M('DS_CHARGE', 'reconcile_record', 'rec_id', 'RECONCILE', 'rec_id'), M('DS_CHARGE', 'reconcile_record', 'channel', 'RECONCILE', 'channel'),
  M('DS_CHARGE', 'reconcile_record', 'diff', 'RECONCILE', 'diff'), M('DS_CHARGE', 'reconcile_record', 'status', 'RECONCILE', 'status'),
  M('DS_PHARMACY', 'dispense_record', 'dispense_id', 'DISPENSE', 'dispense_id'), M('DS_PHARMACY', 'dispense_record', 'order_id', 'DISPENSE', 'order_id'),
  M('DS_PHARMACY', 'dispense_record', 'item_code', 'DISPENSE', 'item_code'),
  M('DS_PHARMACY', 'dispense_record', 'status', 'DISPENSE', 'status', '{"0":"已调剂","1":"已发药","2":"已退药"}'),
  M('DS_PHARMACY', 'dispense_record', 'pharmacist', 'DISPENSE', 'pharmacist'),
  M('DS_PHARMACY', 'drug_stock', 'drug_code', 'DRUG_STOCK', 'drug_code'), M('DS_PHARMACY', 'drug_stock', 'quantity', 'DRUG_STOCK', 'quantity'),
  M('DS_PHARMACY', 'drug_stock', 'warehouse', 'DRUG_STOCK', 'warehouse'),
  M('DS_PHARMACY', 'purchase_order', 'po_id', 'DRUG_PURCHASE', 'po_id'), M('DS_PHARMACY', 'purchase_order', 'quantity', 'DRUG_PURCHASE', 'quantity'),
  M('DS_PHARMACY', 'purchase_order', 'status', 'DRUG_PURCHASE', 'status'),
  M('DS_PHARMACY', 'stock_in', 'in_id', 'STOCK_IN', 'in_id'), M('DS_PHARMACY', 'stock_in', 'quantity', 'STOCK_IN', 'quantity'),
  M('DS_PHARMACY', 'stock_out', 'out_id', 'STOCK_OUT', 'out_id'), M('DS_PHARMACY', 'stock_out', 'quantity', 'STOCK_OUT', 'quantity'),
  M('DS_PHARMACY', 'stock_out', 'out_type', 'STOCK_OUT', 'out_type'),
  M('DS_PHARMACY', 'presc_review', 'review_id', 'PRESC_REVIEW', 'review_id'),
  M('DS_PHARMACY', 'presc_review', 'review_result', 'PRESC_REVIEW', 'review_result'),
  M('DS_PHARMACY', 'presc_review', 'reject_reason', 'PRESC_REVIEW', 'reject_reason'),
  M('DS_OPD', 'opd_reg', 'reg_id', 'REGISTER', 'reg_id'), M('DS_OPD', 'opd_reg', 'pat_card_no', 'REGISTER', 'pat_card_no'),
  M('DS_OPD', 'opd_reg', 'reg_dept', 'REGISTER', 'reg_dept'), M('DS_OPD', 'opd_reg', 'reg_fee', 'REGISTER', 'reg_fee'),
  M('DS_OPD', 'opd_reg', 'reg_status', 'REGISTER', 'reg_status', '{"1":"已挂号","2":"已退号"}'),
  M('DS_OPD', 'opd_visit', 'visit_id', 'OPD_VISIT', 'visit_id'), M('DS_OPD', 'opd_visit', 'card_no', 'OPD_VISIT', 'card_no'),
  M('DS_OPD', 'opd_visit', 'diag', 'OPD_VISIT', 'diag'), M('DS_OPD', 'opd_visit', 'doctor', 'OPD_VISIT', 'doctor'),
  M('DS_OPD', 'opd_visit', 'status', 'OPD_VISIT', 'status'),
  M('DS_EMR', 'emr_record', 'record_id', 'EMR_RECORD', 'record_id'), M('DS_EMR', 'emr_record', 'inhos_no', 'EMR_RECORD', 'inhos_no'),
  M('DS_EMR', 'emr_record', 'record_type', 'EMR_RECORD', 'record_type'), M('DS_EMR', 'emr_record', 'diag_main', 'EMR_RECORD', 'diag_main'),
  M('DS_EMR', 'emr_record', 'diag_list', 'EMR_RECORD', 'diag_list'), M('DS_EMR', 'emr_record', 'qc_status', 'EMR_RECORD', 'qc_status'),
  M('DS_EMR', 'emr_surgery', 'surg_id', 'PROCEDURE', 'surg_id'), M('DS_EMR', 'emr_surgery', 'proc_name', 'PROCEDURE', 'proc_name'),
  M('DS_EMR', 'emr_surgery', 'proc_level', 'PROCEDURE', 'proc_level'), M('DS_EMR', 'emr_surgery', 'surgeon', 'PROCEDURE', 'surgeon'),
  M('DS_EMR', 'patient_allergy', 'inhos_no', 'PATIENT_ALLERGY', 'inhos_no'), M('DS_EMR', 'patient_allergy', 'allergen', 'PATIENT_ALLERGY', 'allergen'),
  M('DS_EMR', 'patient_allergy', 'severity', 'PATIENT_ALLERGY', 'severity'),
  M('DS_EMR', 'drg_group', 'drg_id', 'DRG_GROUP', 'drg_id'), M('DS_EMR', 'drg_group', 'drg_code', 'DRG_GROUP', 'drg_code'),
  M('DS_EMR', 'drg_group', 'drg_name', 'DRG_GROUP', 'drg_name'), M('DS_EMR', 'drg_group', 'weight', 'DRG_GROUP', 'weight'),
  M('DS_EMR', 'infection_report', 'report_id', 'INFECTION_REPORT', 'report_id'),
  M('DS_EMR', 'infection_report', 'infection_type', 'INFECTION_REPORT', 'infection_type'),
  M('DS_EMR', 'infection_report', 'pathogen', 'INFECTION_REPORT', 'pathogen'),
  M('DS_EMR', 'infection_report', 'status', 'INFECTION_REPORT', 'status'),
  M('DS_EMR', 'followup', 'fu_id', 'FOLLOWUP', 'fu_id'), M('DS_EMR', 'followup', 'fu_type', 'FOLLOWUP', 'fu_type'),
  M('DS_EMR', 'followup', 'status', 'FOLLOWUP', 'status'),
  M('DS_PACS', 'exam_report', 'exam_id', 'CHECK_REPORT', 'exam_id'), M('DS_PACS', 'exam_report', 'order_id', 'CHECK_REPORT', 'order_id'),
  M('DS_PACS', 'exam_report', 'abnormal_flag', 'CHECK_REPORT', 'abnormal_flag', '{"Y":"异常","N":"正常"}'),
  M('DS_PACS', 'exam_report', 'conclusion', 'CHECK_REPORT', 'conclusion'),
  M('DS_NURSE', 'nurse_exec', 'exec_id', 'NURSE_EXEC', 'exec_id'), M('DS_NURSE', 'nurse_exec', 'order_id', 'NURSE_EXEC', 'order_id'),
  M('DS_NURSE', 'nurse_exec', 'exec_type', 'NURSE_EXEC', 'exec_type'),
  M('DS_NURSE', 'nurse_exec', 'exec_status', 'NURSE_EXEC', 'exec_status', '{"1":"已执行","0":"未执行"}'),
  M('DS_NURSE', 'nurse_exec', 'nurse', 'NURSE_EXEC', 'nurse'),
  M('DS_NURSE', 'vital_sign', 'vs_id', 'VITAL_SIGN', 'vs_id'), M('DS_NURSE', 'vital_sign', 'temperature', 'VITAL_SIGN', 'temperature'),
  M('DS_NURSE', 'vital_sign', 'pulse', 'VITAL_SIGN', 'pulse'), M('DS_NURSE', 'vital_sign', 'bp', 'VITAL_SIGN', 'bp'),
  M('DS_MATERIAL', 'material_stock', 'material_code', 'MATERIAL_STOCK', 'material_code'),
  M('DS_MATERIAL', 'material_stock', 'quantity', 'MATERIAL_STOCK', 'quantity'),
  M('DS_MATERIAL', 'material_stock', 'warehouse', 'MATERIAL_STOCK', 'warehouse'),
  M('DS_MATERIAL', 'material_apply', 'apply_id', 'MATERIAL_APPLY', 'apply_id'),
  M('DS_MATERIAL', 'material_apply', 'quantity', 'MATERIAL_APPLY', 'quantity'),
  M('DS_MATERIAL', 'material_apply', 'status', 'MATERIAL_APPLY', 'status'),
  M('DS_MATERIAL', 'material_in', 'in_id', 'MATERIAL_IN', 'in_id'), M('DS_MATERIAL', 'material_in', 'quantity', 'MATERIAL_IN', 'quantity'),
  M('DS_MATERIAL', 'material_out', 'out_id', 'MATERIAL_OUT', 'out_id'), M('DS_MATERIAL', 'material_out', 'quantity', 'MATERIAL_OUT', 'quantity'),
];

const KNOWLEDGE = [
  ['RECON_ATTR_VIOLATION_PREPAY_BYPASS', '归因：先药后费违规', '已发药但患者无任何有效缴费记录，属先药后费违规，违反"缴费是发药前置"流程公理。需逐笔追缴并核查发药窗口放行原因。', 'DISPENSE,PAYMENT'],
  ['RECON_ATTR_RETURNED_PENDING_REFUND', '归因：已退药待退费', '已退药但对应费用未退费，是"业务完成≠财务到账"的中间态，需触发退费流程并核对退费时效。', 'DISPENSE,REFUND'],
  ['RECON_ATTR_STUCK_BACKLOG', '归因：真实滞留', '已计费已缴费且医嘱已执行，但药房无发药记录，属真实滞留，需催办药房发药或发起退费。', 'DISPENSE,FEE_DETAIL'],
  ['RECON_ATTR_IN_FLIGHT', '归因：在途待发', '已缴费但医嘱未执行，属在途待发的正常差异，无需处理，显式登记防止误判为滞留。', 'MEDICAL_ORDER,PAYMENT'],
  ['RECON_ATTR_CANCELLED_AFTER_PAY', '归因：缴费后取消', '缴费后医嘱被取消（非凌晨批量窗口），需人工核对退费是否完成。', 'MEDICAL_ORDER,REFUND'],
  ['RECON_ATTR_NIGHTLY_CANCEL', '归因：凌晨批量取消', '凌晨 6 点前批量取消窗口内的自然取消（未缴费超时自动取消），属正常差异，归因消除。', 'MEDICAL_ORDER'],
  ['CS_RULE_FEE_ROOT', '客服规则：取消未退费根因', '费用投诉根因：LIS v5.2 升级（2026-08-15）将检验撤销状态码由 X 改为 C，HIS 计费适配器 status_map 未同步配置新码 C 的退费映射，导致升级后已撤销的检验医嘱仍正常计费。', 'FEE_DETAIL,LAB_APPLY'],
  ['CS_RULE_FEE_DISPENSE_ORDER', '客服规则：缴费是发药前置', '缴费是发药的前置环节：正常流程为缴费→调剂→发药；出现先药后费属流程违规，需追缴。', 'PAYMENT,DISPENSE'],
  ['CS_RULE_DISPENSE_SPLIT', '客服规则：医嘱可分次发药', '一条药品医嘱与发药记录是 1:N 关系，允许分次发药；核对时按医嘱号分组判断，不能简单一一对应。', 'DISPENSE,MEDICAL_ORDER'],
  ['CS_RULE_REFUND_PAIR', '客服规则：退药退费成对', '退药与退费必须成对出现：先退药后退费；只有退费无退药或反之均为异常。', 'REFUND,DISPENSE'],
];

// 链路故事线（V17/V18）
const LINK_NODES = [
  ['REQUIREMENT', 'REQ-20260610-008', '检验撤销后自动退费需求', 'FEE_DETAIL', '已上线', '2026-06-10T10:00:00', '{}'],
  ['TESTCASE', 'TC-FEE-0032', '取消医嘱不计费校验用例', 'FEE_DETAIL', '已通过', '2026-06-20T10:00:00', '{}'],
  ['CHANGE', 'CHG-LIS-20260815-V52', 'LIS v5.2 撤销状态码 X→C 变更', 'LAB_APPLY', '已发布', '2026-08-15T09:00:00', '{"system":"LIS","version":"v5.2"}'],
  ['DEPLOY', 'DEPLOY-LIS-20260815', 'LIS v5.2 生产发布', 'LAB_APPLY', '成功', '2026-08-15T22:00:00', '{}'],
  ['TICKET', 'T-20260901-001', '投诉：检验取消了还在收费（张建国）', 'FEE_DETAIL', '待处理', '2026-09-01T09:20:00', '{"inhos_no":"ZY20260815001","patient":"张*国","content":"8月30日取消了血常规检验，费用还在","amount":25}'],
  ['TICKET', 'T-20260905-002', '投诉：退费迟迟不到账（王秀兰）', 'FEE_DETAIL', '待处理', '2026-09-05T14:00:00', '{"inhos_no":"ZY20260818003","patient":"王*兰","content":"肝功能撤销后退费未到账","amount":60}'],
  ['TICKET', 'T-20260802-101', '发药记录与缴费不符（李红梅）', 'DISPENSE', '已处置', '2026-08-02T10:00:00', '{"inhos_no":"ZY20260816002","patient":"李*梅"}'],
  ['REQUIREMENT', 'REQ-20260805-012', '发药缴费核对增强', 'DISPENSE', '已上线', '2026-08-05T10:00:00', '{}'],
  ['CHANGE', 'CHG-HIS-20260812-V61', 'HIS v6.1 发药缴费联动', 'DISPENSE', '已发布', '2026-08-12T10:00:00', '{}'],
  ['TESTCASE', 'TC-DISP-0018', '分次发药核对用例', 'DISPENSE', '已通过', '2026-08-13T10:00:00', '{}'],
  ['DEPLOY', 'DEPLOY-HIS-20260820', 'HIS v6.1 生产发布', 'DISPENSE', '成功', '2026-08-20T20:00:00', '{}'],
  ['DISPOSAL', 'DIS-20260821-001', '客服差异处置单（李红梅）', 'DISPENSE', '已办结', '2026-08-21T09:00:00', '{}'],
  ['REQUIREMENT', 'REQ-20260902-015', '病案首页质控规则增强', 'EMR_RECORD', '开发中', '2026-09-02T10:00:00', '{}'],
  ['CHANGE', 'CHG-QC-20260908-R20', '质控规则 R20 上线', 'EMR_RECORD', '已发布', '2026-09-08T10:00:00', '{}'],
  ['ALERT', 'ALERT-LR202609100209', '血钾 6.8 危急值（杨光）', 'LAB_REPORT', '已闭环', '2026-09-10T02:09:00', '{"inhos_no":"ZY20260822007","patient":"杨*"}'],
  ['DISPOSAL', 'DIS-20260910-002', '危急值处置单（杨光）', 'LAB_REPORT', '已办结', '2026-09-10T03:00:00', '{}'],
  ['TICKET', 'T-AUTO-20260913-004', '自动检测：取消未退费（王强）', 'FEE_DETAIL', '待处理', '2026-09-13T08:00:00', '{"inhos_no":"ZY20260810003","patient":"王*","feeCount":1,"amount":80}'],
  ['TICKET', 'T-AUTO-20260913-005', '自动检测：取消未退费（刘伟）', 'FEE_DETAIL', '待处理', '2026-09-13T08:00:00', '{"inhos_no":"ZY20260820005","patient":"刘*","feeCount":1,"amount":15}'],
  ['TICKET', 'T-AUTO-20260913-006', '自动检测：取消未退费（杨光）', 'FEE_DETAIL', '待处理', '2026-09-13T08:00:00', '{"inhos_no":"ZY20260822007","patient":"杨*","feeCount":1,"amount":25}'],
  ['TICKET', 'T-GOV-GOV-004', '治理转办：检验状态字典跨库不一致', 'FEE_DETAIL', '待处理', '2026-09-13T09:00:00', '{"ruleCode":"GOV-004","patient":"张*国"}'],
  ['TICKET', 'T-20260911-101', '退费无立项问题（赵敏）', 'REFUND', '待处理', '2026-09-11T10:00:00', '{"inhos_no":"ZY20260824008","patient":"赵*"}'],
];
const LINK_RELS = [
  ['CHG-LIS-20260815-V52', 'T-20260901-001', 'CAUSES', '根因：LIS v5.2 撤销码变更'],
  ['CHG-LIS-20260815-V52', 'T-20260905-002', 'CAUSES', '根因：LIS v5.2 撤销码变更'],
  ['CHG-LIS-20260815-V52', 'DEPLOY-LIS-20260815', 'SHIPPED_BY', ''],
  ['CHG-LIS-20260815-V52', 'T-AUTO-20260913-004', 'CAUSES', '根因分析关联'],
  ['CHG-LIS-20260815-V52', 'T-AUTO-20260913-005', 'CAUSES', '根因分析关联'],
  ['CHG-LIS-20260815-V52', 'T-AUTO-20260913-006', 'CAUSES', '根因分析关联'],
  ['CHG-LIS-20260815-V52', 'T-GOV-GOV-004', 'CAUSES', '治理扫描定位'],
  ['REQ-20260610-008', 'TC-FEE-0032', 'COVERED_BY', ''],
  ['T-20260802-101', 'REQ-20260805-012', 'TRIGGERS', ''],
  ['REQ-20260805-012', 'CHG-HIS-20260812-V61', 'LEADS_TO', ''],
  ['CHG-HIS-20260812-V61', 'TC-DISP-0018', 'COVERED_BY', ''],
  ['CHG-HIS-20260812-V61', 'DEPLOY-HIS-20260820', 'SHIPPED_BY', ''],
  ['T-20260802-101', 'DIS-20260821-001', 'CLOSED_BY', ''],
  ['ALERT-LR202609100209', 'DIS-20260910-002', 'CLOSED_BY', ''],
  ['T-20260911-101', 'T-20260905-002', 'RELATES', '同根因场景'],
];

// 种子制度文档
const DOCS = [
  {
    title: '费用与退费管理制度', docType: 'MD', owner: '收费处',
    content: `# 费用与退费管理制度

## 缴费管理
住院患者实行预交金制度，出院时多退少补。结算补缴须在办理出院手续前完成。
门诊实行先缴费后执行：处方开立后须完成缴费，药房方可调剂发药。

## 退费流程
检验检查项目取消的，收费处应在取消当日完成退费。
药品退费须先到药房办理退药，凭退药凭证到收费处退费，先退药后退费，两者必须成对。
结算冲红须双人复核，冲红后重新结算并开具新发票。

## 日终对账
收费处每日与渠道方（现金/扫码/医保）轧账，差异当日查明，轧账不平不得离岗。
`,
  },
  {
    title: '检验系统(LIS)v5.2升级通告', docType: 'MD', owner: '信息科',
    content: `# 检验系统(LIS)v5.2升级通告

## 变更内容
自 2026 年 8 月 15 日起，LIS 升级至 v5.2。检验申请撤销状态码由 X（已撤销）变更为 C（已撤销），旧码 X 停用。

## 影响范围
各对接系统需同步更新状态字典：HIS 计费适配器、护士站、病历系统。
撤销申请的退费联动依赖状态码映射，请各系统在切换前完成联调验证。

## 联系方式
接口问题请联系信息科值班电话 8001。
`,
  },
];

export async function seedPlatformData(force = false) {
  // 幂等：以最末尾的对账组为标志（种子全部成功才会写入）；force=true 强制清空重播
  if (!force) {
    const done = await platform.prepare("SELECT 1 FROM bm_reconcile_group WHERE group_code='DISCHARGE_CLOSE'").get();
    if (done) return false;
  }

  await platform.exec('BEGIN');
  try {
    await seedAll();
    await platform.exec('COMMIT');
    return true;
  } catch (e) {
    try { await platform.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

async function seedAll() {
  // 动态清空平台库全部业务表（排除 bm_user——seedUsers 在外层管理，开发态先于本函数执行；
  // 同时排除 bm_login_audit——登录审计属于安全留痕，不随演示数据重种子而清空）。
  // 生产首次启动为空库时是空操作；测试重复运行时清掉上次残留的运行时数据（发布/工单/对账/质控等）。
  const tbls = (await platform.prepare("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('bm_user','bm_login_audit')").all())
    .map(r => `"${r.tablename}"`);
  if (tbls.length) await platform.prepare(`TRUNCATE TABLE ${tbls.join(',')} CASCADE`).run();

  const insDomain = platform.prepare('INSERT INTO bm_domain(code,name,description,sort) VALUES (?,?,?,?)');
  for (const d of DOMAINS) await insDomain.run(...d);

  const insConcept = platform.prepare('INSERT INTO bm_concept(code,name,domain_code,definition,owner,status,version) VALUES (?,?,?,?,?,?,1)');
  const insAttr = platform.prepare('INSERT INTO bm_attribute(concept_code,attr_code,attr_name,data_type,is_key,definition,sort) VALUES (?,?,?,?,?,?,?)');
  for (const [code, name, domain, def, owner, attrs] of CONCEPTS) {
    await insConcept.run(code, name, domain, def, owner, 'PUBLISHED');
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      await insAttr.run(code, a[0], a[1], a[2], a[3] ? 1 : 0, a[4] || '', i);
    }
  }

  const insRel = platform.prepare(`INSERT INTO bm_relation(from_concept,to_concept,relation_name,description,is_symmetric,is_transitive,is_functional,is_inverse_functional,is_asymmetric,inverse_of)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const [f, t, n, d, ax, inv] of RELATIONS) {
    await insRel.run(f, t, n, d || '', ax.sym ? 1 : 0, ax.trans ? 1 : 0, ax.func ? 1 : 0, ax.invFunc ? 1 : 0, ax.asym ? 1 : 0, inv);
  }

  const insParent = platform.prepare('INSERT INTO bm_concept_parent(child_code,parent_code,is_primary) VALUES (?,?,?)');
  for (const p of PARENTS) await insParent.run(...p);

  const insDis = platform.prepare('INSERT INTO bm_concept_disjoint(concept_a_code,concept_b_code,definition) VALUES (?,?,?)');
  for (const d of DISJOINTS) await insDis.run(...d);

  const insAxiom = platform.prepare('INSERT INTO bm_axiom(axiom_code,subject,predicate,object,axiom_type,description) VALUES (?,?,?,?,?,?)');
  // AXIOMS 种子元组为 5 元（无 axiom_type），PG 严格绑定要求参数数一致——取 predicate 充当公理类型
  for (const [code, subj, pred, obj, desc] of AXIOMS) await insAxiom.run(code, subj, pred, obj, pred, desc);

  const insTerm = platform.prepare('INSERT INTO bm_term(term,concept_code,source_product,term_type,code_system,standard_code) VALUES (?,?,?,?,?,?)');
  for (const t of TERMS) await insTerm.run(...t);

  const insMetric = platform.prepare(`INSERT INTO bm_metric(metric_code,name,definition,formula,concept_code,owner,ds_code,probe_sql,warn_threshold)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const m of METRICS) await insMetric.run(...m);

  const insRule = platform.prepare(`INSERT INTO bm_rule(rule_code,name,concept_code,rule_type,expression,metric_code,severity,owner,status,version,engine,expr_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of RULES) {
    const [code, name, concept, type, expr, metric, sev, owner, engine, exprJson] = r;
    await insRule.run(code, name, concept, type, expr, metric, sev, owner, 'PUBLISHED', 1, engine || null, exprJson || null);
  }

  const insAction = platform.prepare(`INSERT INTO bm_action(action_code,name,concept_code,from_status,to_status,trigger_desc,description,status,version)
    VALUES (?,?,?,?,?,?,?,?,1)`);
  for (const a of ACTIONS) await insAction.run(...a, 'PUBLISHED');

  const insGov = platform.prepare('INSERT INTO bm_gov_rule(rule_code,rule_name,rule_type,concept_code,severity,expr_json,status) VALUES (?,?,?,?,?,?,?)');
  for (const g of GOV_RULES) await insGov.run(g[0], g[1], g[2], g[3], g[4], JSON.stringify(g[5]), 'PUBLISHED');

  const insDs = platform.prepare('INSERT INTO bm_datasource(ds_code,ds_name,product_name,db_type,host,port,db_name,username,password) VALUES (?,?,?,?,?,?,?,?,?)');
  for (const [code, name, product, dbname] of DATASOURCES) {
    await insDs.run(code, name, product, 'POSTGRESQL', config.pg.host, config.pg.port, dbname, 'demo', encryptSecret('demo'));
  }

  const insMap = platform.prepare(`INSERT INTO bm_mapping(ds_code,table_name,column_name,concept_code,attr_code,value_map,confirmed,source,status,updated_by,updated_at)
    VALUES (?,?,?,?,?,?,1,'MANUAL','ACTIVE','system',?)`);
  for (const m of MAPPINGS) await insMap.run(m[0], m[1], m[2], m[3], m[4], m[5], now());

  const insKnow = platform.prepare(`INSERT INTO bm_knowledge(code,title,content,applies_to,concept_code,source,status,version,owner)
    VALUES (?,?,?,?,?, 'SEED','PUBLISHED',1,?)`);
  for (const k of KNOWLEDGE) await insKnow.run(k[0], k[1], k[2], k[3], null, k[3].split(',')[0] === 'DISPENSE' ? '客服组 周颖' : '信息科');

  const insNode = platform.prepare('INSERT INTO link_node(node_type,ref_no,title,concept_code,status,occurred_at,payload) VALUES (?,?,?,?,?,?,?)');
  for (const nd of LINK_NODES) await insNode.run(...nd);
  const insRelL = platform.prepare('INSERT INTO link_rel(from_ref_no,to_ref_no,rel_type,remark) VALUES (?,?,?,?)');
  for (const r of LINK_RELS) await insRelL.run(...r);

  // 种子文档（已发布）+ 切片
  const insDoc = platform.prepare('INSERT INTO bm_document(title,doc_type,source,status,version,owner,uploaded_by,file_size,content_hash,content_text) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const insChunk = platform.prepare('INSERT INTO bm_doc_chunk(document_id,seq,heading,content) VALUES (?,?,?,?)');
  const insFts = platform.prepare('INSERT INTO bm_doc_chunk_fts(chunk_id,content) VALUES (?,?)');
  for (const doc of DOCS) {
    const hash = doc.title; // 种子以标题为指纹即可
    const r = await insDoc.run(doc.title, doc.docType, 'SEED', 'PUBLISHED', 1, doc.owner, 'system', doc.content.length, hash, doc.content);
    const docId = r.lastInsertRowid;
    let seq = 0, heading = '';
    for (const para of doc.content.split(/\n\n+/)) {
      const h = para.match(/^##\s+(.+)$/m);
      if (h) heading = h[1];
      const text = para.replace(/^#+\s+.*$/m, '').trim();
      if (!text) continue;
      const c = await insChunk.run(docId, seq++, heading, text.slice(0, 500));
      await insFts.run(c.lastInsertRowid, text.slice(0, 500));
    }
  }

  // 对账组（出院人数：HIS 口径 vs 结算口径，预置归因桶）
  const insGroup = platform.prepare(`INSERT INTO bm_reconcile_group(group_code,name,definition,metric_codes,drill_ds_code,drill_sql,owner,dispute_status,buckets_json,scheduled)
    VALUES (?,?,?,?,?,?,?,?,?,1)`);
  await insGroup.run(
    'DISCHARGE_CLOSE', '出院人数：HIS×结算对账',
    'HIS 出院人数与收费结算单笔数存在口径差，用归因桶拆解差异来源。',
    'DISCHARGE_COUNT,SETTLE_COUNT', 'DS_HIS',
    "SELECT inhos_no, patient_name, dept, status FROM inpatient WHERE status='出院' ORDER BY inhos_no",
    '医务处', 'OPEN',
    JSON.stringify([
      { label: '在院未结算（正常）', dsCode: 'DS_HIS', sign: -1, sql: "SELECT COUNT(*) FROM inpatient WHERE status='在院'" },
      { label: '取消未结算（裂缝）', dsCode: 'DS_HIS', sign: -1, sql: "SELECT COUNT(DISTINCT o.inhos_no) FROM medical_order o JOIN fee_detail f ON f.order_id=o.order_id WHERE o.order_status='2' AND f.fee_status='1'" },
    ]));

  await seedPhysicalSnapshots();
  return true;
}

// 物理快照：对九个演示库做一次真实扫描（等价 information_schema 扫描落 bm_physical_*）
export async function seedPhysicalSnapshots() {
  const delT = platform.prepare('DELETE FROM bm_physical_table WHERE ds_code=?');
  const delC = platform.prepare('DELETE FROM bm_physical_column WHERE ds_code=?');
  const insT = platform.prepare('INSERT INTO bm_physical_table(ds_code,table_name,table_comment,scanned_at) VALUES (?,?,?,?)');
  const insC = platform.prepare('INSERT INTO bm_physical_column(ds_code,table_name,column_name,data_type,column_comment,is_pk,ordinal_position) VALUES (?,?,?,?,?,?,?)');
  const st = now();
  for (const [dsCode, , , dbname] of DATASOURCES) {
    let db; try { db = await businessDb(dsCode); } catch { continue; }
    await delT.run(dsCode); await delC.run(dsCode);
    // PG：用 information_schema.tables / columns 取物理元数据
    const tables = await db.prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name").all();
    for (const t of tables) {
      await insT.run(dsCode, t.name, '', st);
      const cols = await db.prepare(`SELECT column_name AS name, data_type AS type, ordinal_position AS pos FROM information_schema.columns WHERE table_schema='public' AND table_name=? ORDER BY ordinal_position`).all(t.name);
      // 主键列标记
      const pkRes = await db.prepare("SELECT column_name FROM information_schema.key_column_usage WHERE table_schema='public' AND table_name=? AND constraint_name LIKE '%_pkey'").all(t.name);
      const pkSet = new Set(pkRes.map(r => r.column_name));
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        await insC.run(dsCode, t.name, c.name, c.type || 'TEXT', '', pkSet.has(c.name) ? 1 : 0, c.pos);
      }
    }
  }
}

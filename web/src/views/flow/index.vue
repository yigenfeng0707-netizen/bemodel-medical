<template>
  <div class="page">
    <el-row :gutter="12">
      <el-col :span="8">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <el-radio-group v-model="mode" size="small">
                <el-radio-button value="INP">住院</el-radio-button>
                <el-radio-button value="OPD">门诊</el-radio-button>
              </el-radio-group>
              <el-input v-model="keyword" size="small" placeholder="搜索姓名/单号" style="width:150px" clearable @input="loadPatients" />
            </div>
          </template>
          <div style="max-height:640px;overflow:auto">
            <div v-for="p in patients" :key="p.inhos_no || p.pat_card_no" class="pat-card" :class="{ active: curKey === (p.inhos_no || p.pat_card_no) }" @click="selectPatient(p)">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <b>{{ p.patient_name || p.pat_name }}</b>
                <el-tag size="small" :type="p.status === '在院' ? 'success' : p.reg_status === '2' ? 'info' : 'primary'">{{ p.status || (p.reg_status === '2' ? '已退号' : '门诊') }}</el-tag>
              </div>
              <div style="font-size:12px;color:var(--text-3)">{{ p.inhos_no || p.pat_card_no }} · {{ p.dept || p.reg_dept }} · {{ p.doctor || p.reg_doctor }}</div>
              <div style="font-size:12px;color:var(--text-2);margin-top:2px">医嘱 {{ p.orderCount }} 条 · 费用 ¥{{ p.feeTotal }}<template v-if="mode === 'OPD'"> 处方 {{ p.prescCount }} 条 · 已执行 ¥{{ p.execTotal }}</template></div>
            </div>
          </div>
          <el-pagination v-model:current-page="pageNo" :page-size="20" :total="total" layout="prev, pager, next" style="margin-top:8px" @current-change="loadPatients" />
        </el-card>
      </el-col>
      <el-col :span="16">
        <el-card shadow="never" v-if="loop">
          <template #header>
            <div class="card-header">
              <b>就诊看板：{{ loop.patient?.patient_name || loop.reg?.pat_name }}</b>
              <el-button v-if="mode === 'INP'" size="small" :href="rdfUrl" tag="a" :download="`${curKey}.ttl`">导出该患者 ABox（Turtle）</el-button>
            </div>
          </template>
          <template v-if="mode === 'INP'">
            <el-descriptions :column="3" size="small" border class="mb12">
              <el-descriptions-item label="住院号">{{ loop.patient.inhos_no }}</el-descriptions-item>
              <el-descriptions-item label="性别/年龄">{{ loop.patient.sex }} / {{ loop.patient.age }}</el-descriptions-item>
              <el-descriptions-item label="状态">{{ loop.patient.status }}</el-descriptions-item>
              <el-descriptions-item label="科室/病区">{{ loop.patient.dept }} / {{ loop.patient.ward }}</el-descriptions-item>
              <el-descriptions-item label="主管医生"><el-link @click="openStaff(loop.patient.doctor)">{{ loop.patient.doctor }}</el-link></el-descriptions-item>
              <el-descriptions-item label="入/出院">{{ loop.patient.admit_time }} ~ {{ loop.patient.discharge_time || '—' }}</el-descriptions-item>
              <el-descriptions-item label="费用合计">¥{{ loop.feeTotal }}</el-descriptions-item>
              <el-descriptions-item label="已缴金额">¥{{ loop.paidTotal }}</el-descriptions-item>
              <el-descriptions-item label="结算总额">¥{{ loop.settleTotal }}</el-descriptions-item>
            </el-descriptions>
            <div class="mb12"><b>医嘱闭环</b></div>
            <el-table :data="loop.orders" size="small" class="mb12" max-height="300">
              <el-table-column prop="orderId" label="医嘱号" width="150" class-name="mono" />
              <el-table-column prop="itemName" label="项目" min-width="130" />
              <el-table-column label="类型" width="80"><template #default="{ row }"><el-tag size="small" :type="{ 检验: 'primary', 药品: 'success', 检查: 'warning' }[row.orderType]">{{ row.orderType }}</el-tag></template></el-table-column>
              <el-table-column label="医生" width="100"><template #default="{ row }"><el-link @click="openStaff(row.doctor)">{{ row.doctor }}</el-link></template></el-table-column>
              <el-table-column label="计费" width="140">
                <template #default="{ row }">{{ row.fee ? `¥${row.fee.amount}（${row.fee.feeStatus === '2' ? '已退费' : '正常'}）` : '—' }}</template>
              </el-table-column>
              <el-table-column label="执行环节" min-width="180">
                <template #default="{ row }">
                  <span v-if="row.orderType === '检验'">申请 {{ row.execInfo?.applyStatus }} → 报告 {{ row.execInfo?.reportStatus }}</span>
                  <span v-else-if="row.orderType === '检查'">报告 {{ row.execInfo?.abnormalFlag === 'Y' ? '⚠ 异常' : '正常' }}</span>
                  <span v-else-if="row.orderType === '药品'">发药 {{ row.execInfo?.dispenseStatus }} · 审方 <el-link v-if="row.execInfo?.reviewResult" @click="openStaff(row.execInfo?.pharmacist2 || row.execInfo?.pharmacist)">{{ row.execInfo?.reviewResult }}</el-link></span>
                  <span v-if="row.execInfo?.nurse"> · 护士 <el-link @click="openStaff(row.execInfo.nurse)">{{ row.execInfo.nurse }}</el-link></span>
                </template>
              </el-table-column>
              <el-table-column label="闭环" width="130">
                <template #default="{ row }">
                  <el-tag size="small" :type="loopTag(row.loopStatus)">{{ loopText(row.loopStatus) }}</el-tag>
                  <el-button v-if="row.loopStatus === 'BROKEN'" size="small" text type="danger" @click="$router.push('/cs')">根因分析</el-button>
                </template>
              </el-table-column>
            </el-table>
            <div class="mb12"><b>缴费与结算</b></div>
            <el-table :data="loop.payments" size="small" class="mb12" max-height="180">
              <el-table-column prop="pay_time" label="时间" width="170" />
              <el-table-column label="类型" width="110"><template #default="{ row }"><el-tag size="small" :type="{ 预交金: 'primary', 结算补缴: 'success', 退费: 'danger', 门诊缴费: 'primary' }[row.payTypeName]">{{ row.payTypeName }}</el-tag></template></el-table-column>
              <el-table-column prop="amount" label="金额" width="110" />
              <el-table-column prop="channel" label="渠道" width="90" />
              <el-table-column prop="operator" label="操作员" width="100" />
            </el-table>
          </template>
          <template v-else>
            <el-descriptions :column="3" size="small" border class="mb12">
              <el-descriptions-item label="卡号">{{ loop.reg.pat_card_no }}</el-descriptions-item>
              <el-descriptions-item label="挂号科室">{{ loop.reg.reg_dept }}</el-descriptions-item>
              <el-descriptions-item label="挂号状态">{{ loop.reg.reg_status === '2' ? '已退号' : '已挂号' }}</el-descriptions-item>
            </el-descriptions>
            <el-table :data="loop.prescs" size="small" class="mb12" max-height="300">
              <el-table-column prop="presc_id" label="处方号" width="150" class-name="mono" />
              <el-table-column prop="item_name" label="项目" min-width="130" />
              <el-table-column prop="presc_status" label="状态" width="90" />
              <el-table-column label="闭环" width="130"><template #default="{ row }"><el-tag size="small" :type="loopTag(row.loopStatus)">{{ loopText(row.loopStatus) }}</el-tag></template></el-table-column>
            </el-table>
          </template>
          <div class="mb12"><b>全流程时间线</b></div>
          <el-timeline>
            <el-timeline-item v-for="(e, i) in shownTimeline" :key="i" :timestamp="e.at">
              <el-tag size="small" :class="`sys-${e.system}`" class="mr4">{{ e.system }}</el-tag>
              <b>{{ e.name }}</b>
              <span style="font-size:12px;color:var(--text-3)"> {{ e.detail }}</span>
            </el-timeline-item>
          </el-timeline>
          <el-button v-if="loop.timeline?.length > 10" size="small" text @click="showAllTimeline = !showAllTimeline">
            {{ showAllTimeline ? '收起' : `展开全部 ${loop.timeline.length} 条` }}
          </el-button>
        </el-card>
        <el-card v-else shadow="never"><el-empty description="选择左侧患者查看全流程闭环" /></el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="staffDlg" :title="staffInfo?.staff?.staff_name || '人员档案'" width="560px">
      <template v-if="staffInfo?.found">
        <el-descriptions :column="2" size="small" border>
          <el-descriptions-item label="工号">{{ staffInfo.staff.staff_id }}</el-descriptions-item>
          <el-descriptions-item label="角色">{{ staffInfo.staff.role }}</el-descriptions-item>
          <el-descriptions-item label="职称">{{ staffInfo.staff.title }}</el-descriptions-item>
          <el-descriptions-item label="科室">{{ staffInfo.dept?.dept_name }}</el-descriptions-item>
        </el-descriptions>
        <div class="mb12" style="margin-top:10px"><b>业务足迹</b></div>
        <div v-for="(v, k) in staffInfo.footprint" :key="k" style="font-size:13px">{{ k }}：<b>{{ v }}</b></div>
        <div v-if="!Object.keys(staffInfo.footprint).length" style="color:var(--warning);font-size:12px">未纳入人员主数据足迹——主数据覆盖缺口，建议补录</div>
      </template>
      <el-empty v-else description="未收录" />
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { listFlowPatients, flowLoop, listOpdPatients, opdLoop, staffTrace, patientRdfUrl } from '../../api';

const mode = ref('INP');
const keyword = ref('');
const patients = ref([]); const total = ref(0); const pageNo = ref(1);
const curKey = ref(''); const loop = ref(null);
const staffDlg = ref(false); const staffInfo = ref(null);
const showAllTimeline = ref(false);
const shownTimeline = computed(() => showAllTimeline.value ? (loop.value?.timeline || []) : (loop.value?.timeline || []).slice(0, 10));
const rdfUrl = computed(() => patientRdfUrl(curKey.value));
const loopText = (s) => ({ CLOSED: '闭环完成', CLOSED_CANCELED: '取消闭环', BROKEN: '异常中断', PENDING: '进行中', UNPAID: '未缴费' }[s] || s);
const loopTag = (s) => ({ CLOSED: 'success', CLOSED_CANCELED: 'info', BROKEN: 'danger', PENDING: 'warning', UNPAID: 'warning' }[s] || 'info');

async function loadPatients() {
  if (mode.value === 'INP') {
    const r = await listFlowPatients({ keyword: keyword.value, pageNum: pageNo.value, pageSize: 20 });
    patients.value = r.list; total.value = r.total;
  } else {
    patients.value = (await listOpdPatients()).filter(p => !keyword.value || (p.pat_name || '').includes(keyword.value) || (p.pat_card_no || '').includes(keyword.value));
    total.value = patients.value.length;
  }
  if (patients.value.length && !curKey.value) selectPatient(patients.value[0]);
}
// 门诊/住院切换：清空旧选中键并按新模式重载列表（watch 比 @change 事件更可靠）
watch(mode, () => { curKey.value = ''; loop.value = null; pageNo.value = 1; loadPatients(); });
async function selectPatient(p) {
  const k = p.inhos_no || p.pat_card_no;
  curKey.value = k;
  loop.value = mode.value === 'INP' ? await flowLoop(k) : await opdLoop(k);
  showAllTimeline.value = false;
}
async function openStaff(name) {
  if (!name) return;
  staffInfo.value = await staffTrace(name);
  staffDlg.value = true;
}
onMounted(loadPatients);
</script>

<style scoped>
.pat-card { border: 1px solid #eef2f5; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; cursor: pointer; }
.pat-card:hover { border-color: var(--primary); }
.pat-card.active { border-color: var(--primary); background: #f0faf7; }
.sys-HIS { background: #409eff; } .sys-LIS { background: #67c23a; } .sys-收费 { background: #e6a23c; }
.sys-药房 { background: #722ed1; } .sys-门诊 { background: #3b82f6; } .sys-PACS { background: #13c2c2; } .sys-护士站 { background: #f56c6c; }
.mb12 { margin-bottom: 12px; } .mr4 { margin-right: 4px; }
</style>

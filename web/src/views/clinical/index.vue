<template>
  <div class="page">
    <el-tabs v-model="tab">
      <el-tab-pane label="病案内涵质控" name="qc">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <el-input v-model="keyword" size="small" placeholder="搜索患者/诊断" style="width:200px" clearable @input="loadRecords" />
              <el-button type="primary" size="small" :loading="checkingAll" @click="checkAll">全量内涵质控</el-button>
            </div>
          </template>
          <el-row :gutter="12">
            <el-col :span="10">
              <el-table :data="records" size="small" max-height="560" highlight-current-row @row-click="selectRecord">
                <el-table-column prop="record_id" label="病案号" width="110" class-name="mono" />
                <el-table-column prop="patient_name" label="患者" width="90" />
                <el-table-column prop="record_type" label="类型" width="90" />
                <el-table-column prop="diag_main" label="主诊断" min-width="120" />
                <el-table-column label="质控" width="90">
                  <template #default="{ row }"><el-tag size="small" :type="qcTag(row.qcStatus)">{{ row.qcStatus }}</el-tag></template>
                </el-table-column>
              </el-table>
            </el-col>
            <el-col :span="14">
              <template v-if="curRecord">
                <el-descriptions :column="2" size="small" border class="mb12">
                  <el-descriptions-item label="病案号">{{ curRecord.record_id }}</el-descriptions-item>
                  <el-descriptions-item label="住院号">{{ curRecord.inhos_no }}</el-descriptions-item>
                  <el-descriptions-item label="主诊断">{{ curRecord.diag_main }}</el-descriptions-item>
                  <el-descriptions-item label="全部诊断">{{ curRecord.diag_list }}</el-descriptions-item>
                </el-descriptions>
                <div style="display:flex;gap:8px" class="mb12">
                  <el-button type="primary" size="small" :loading="checking" @click="runQc">发起内涵质控</el-button>
                  <el-button size="small" :loading="shaclLoading" @click="runShacl">SHACL 复核</el-button>
                  <el-button size="small" :href="rdfUrl" tag="a" :download="`${curRecord.inhos_no}.ttl`">导出 ABox</el-button>
                </div>
                <div v-if="qcRes">
                  <el-alert :title="qcRes.pass ? '质控通过' : `质控不通过：${qcRes.findings.length} 项发现`" :type="qcRes.pass ? 'success' : 'error'" class="mb12" :closable="false" />
                  <el-table v-if="qcRes.findings.length" :data="qcRes.findings" size="small" class="mb12">
                    <el-table-column prop="ruleCode" label="规则" width="130" class-name="mono" />
                    <el-table-column prop="ruleName" label="名称" width="130" />
                    <el-table-column prop="severity" label="严重度" width="80" />
                    <el-table-column prop="evidence" label="证据" show-overflow-tooltip />
                  </el-table>
                  <el-alert v-if="qcRes.llmSummary" :title="qcRes.llmSummary" type="info" :closable="false" />
                  <div style="font-size:12px;color:var(--text-3);margin-top:8px">
                    溯源：本体版本 {{ parse(qcRes.trace).ontologyVersion }} · 引用规则 {{ (parse(qcRes.trace).rules || []).join('、') || '—' }} · 涉及概念 {{ (parse(qcRes.trace).concepts || []).join('、') }}
                  </div>
                </div>
                <div v-if="shaclRes">
                  <div class="mb12" style="margin-top:10px"><b>SHACL 校验（{{ shaclRes.engine }}）</b>
                    <el-tag size="small" :type="shaclRes.conforms ? 'success' : 'danger'" class="mr4">{{ shaclRes.conforms ? 'Conforms' : `${shaclRes.violationCount} violations` }}</el-tag>
                  </div>
                  <el-table v-if="shaclRes.violations.length" :data="shaclRes.violations" size="small">
                    <el-table-column prop="focusNode" label="FocusNode" min-width="150" class-name="mono" />
                    <el-table-column prop="path" label="Path" width="130" />
                    <el-table-column prop="message" label="Message" show-overflow-tooltip />
                  </el-table>
                </div>
              </template>
              <el-empty v-else description="选择病案" />
            </el-col>
          </el-row>
        </el-card>
      </el-tab-pane>
      <el-tab-pane label="危重症预警" name="alert" lazy>
        <el-card shadow="never">
          <template #header>
            <div class="card-header"><b>危急值预警（异常检验报告 × 公理 AX-004）</b>
              <el-button type="primary" size="small" :loading="detecting" @click="detect">执行预警检测</el-button>
            </div>
          </template>
          <el-table :data="alerts" size="small">
            <el-table-column prop="ref_no" label="预警号" width="200" class-name="mono" />
            <el-table-column prop="title" label="内容" min-width="260" />
            <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag size="small" :type="row.status === '待处置' ? 'danger' : 'success'">{{ row.status }}</el-tag></template></el-table-column>
            <el-table-column prop="occurred_at" label="时间" width="170" />
          </el-table>
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { listQcRecords, checkQc, checkAllQc, getQcResult, validateShacl, detectAlerts, listLinks, patientRdfUrl } from '../../api';

const tab = ref('qc');
const keyword = ref(''); const records = ref([]); const curRecord = ref(null);
const qcRes = ref(null); const checking = ref(false); const checkingAll = ref(false);
const shaclRes = ref(null); const shaclLoading = ref(false);
const alerts = ref([]); const detecting = ref(false);
const rdfUrl = computed(() => curRecord.value ? patientRdfUrl(curRecord.value.inhos_no) : '');
const qcTag = (s) => ({ 通过: 'success', 不通过: 'danger', 未质控: 'info' }[s] || 'info');
const parse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
async function loadRecords() { records.value = await listQcRecords({ keyword: keyword.value }); }
async function selectRecord(row) {
  curRecord.value = row; qcRes.value = null; shaclRes.value = null;
  qcRes.value = await getQcResult(row.record_id);
}
async function runQc() {
  checking.value = true;
  try { qcRes.value = await checkQc(curRecord.value.record_id); await loadRecords(); curRecord.value = records.value.find(r => r.record_id === curRecord.value.record_id); }
  finally { checking.value = false; }
}
async function checkAll() {
  checkingAll.value = true;
  try { const r = await checkAllQc(); ElMessage.success(`全量质控完成：${r.total} 份，通过 ${r.pass}，不通过 ${r.fail}`); await loadRecords(); }
  finally { checkingAll.value = false; }
}
async function runShacl() {
  shaclLoading.value = true;
  try { shaclRes.value = await validateShacl(curRecord.value.inhos_no); }
  finally { shaclLoading.value = false; }
}
async function detect() {
  detecting.value = true;
  try { const r = await detectAlerts(); ElMessage.success(`异常报告 ${r.abnormalReports}，新增 ${r.created}，已处置 ${r.disposed}`); alerts.value = (await listLinks({ nodeType: 'ALERT', pageSize: 50 })).list; }
  finally { detecting.value = false; }
}
onMounted(async () => { await loadRecords(); alerts.value = (await listLinks({ nodeType: 'ALERT', pageSize: 50 })).list; });
</script>

<style scoped>
.mb12 { margin-bottom: 12px; } .mr4 { margin-right: 4px; }
:deep(.el-table__row) { cursor: pointer; }
</style>

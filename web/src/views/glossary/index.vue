<template>
  <div class="page">
    <el-card shadow="never" class="mb12">
      <div style="display:flex;gap:10px">
        <el-input v-model="q" size="large" placeholder="出院人数怎么算 / 病员是什么" @keyup.enter="doSearch">
          <template #append><el-button @click="doSearch">语义搜索</el-button></template>
        </el-input>
      </div>
      <el-alert v-if="searchResult?.answer" :title="searchResult.answer" type="success" class="mb12" style="margin-top:10px" />
      <el-alert v-if="searchResult?.missRecorded" title="词表暂未收录该说法，已回流本体增长回路（概念缺口）" type="warning" style="margin-top:10px" :closable="false" />
      <el-table v-if="searchResult?.hits?.length" :data="searchResult.hits" size="small" style="margin-top:10px">
        <el-table-column label="类型" width="80"><template #default="{ row }"><el-tag size="small">{{ row.type }}</el-tag></template></el-table-column>
        <el-table-column prop="title" label="标题" min-width="160" />
        <el-table-column prop="conceptCode" label="概念" width="160" />
        <el-table-column prop="content" label="内容" show-overflow-tooltip />
      </el-table>
    </el-card>

    <el-tabs v-model="tab">
      <el-tab-pane label="术语库" name="term">
        <el-card shadow="never">
          <template #header>
            <div class="card-header"><b>术语对齐（方言 → 标准概念）</b>
              <el-button size="small" :disabled="isViewer" @click="termDlg = true">新增术语</el-button>
            </div>
          </template>
          <el-table :data="pagedTerms" size="small">
            <el-table-column prop="term" label="术语" width="140" />
            <el-table-column prop="source_product" label="来源" width="120" />
            <el-table-column label="类型" width="90"><template #default="{ row }"><el-tag size="small" :type="row.term_type === 'STANDARD' ? 'success' : 'info'">{{ row.term_type }}</el-tag></template></el-table-column>
            <el-table-column prop="code_system" label="编码体系" width="110" />
            <el-table-column prop="standard_code" label="标准编码" width="110" class-name="mono" />
            <el-table-column prop="concept_code" label="所属概念" width="200" class-name="mono" />
            <el-table-column label="" width="70"><template #default="{ row }"><el-button size="small" text type="danger" :disabled="isViewer" @click="delTerm(row)">删除</el-button></template></el-table-column>
          </el-table>
          <el-pagination v-model:current-page="termPage" :page-size="20" :total="terms.length" layout="prev, pager, next" style="margin-top:10px" />
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="指标库" name="metric">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <div><b>指标口径卡</b>
                <el-tag size="small" class="mr4">已定义 {{ metrics.length }}</el-tag>
                <el-tag size="small" class="mr4" type="info">接入巡检 {{ probed }} </el-tag>
                <el-tag v-if="alarmedCnt" size="small" type="danger">告警中 {{ alarmedCnt }}</el-tag>
              </div>
              <el-button size="small" type="primary" :loading="evaluating" @click="evalAll">全量巡检</el-button>
            </div>
          </template>
          <el-row :gutter="12">
            <el-col v-for="m in metrics" :key="m.id" :span="8">
              <el-card shadow="hover" class="metric-card mb12">
                <div style="display:flex;justify-content:space-between">
                  <b>{{ m.name }}</b>
                  <el-tag v-if="!m.probe_sql" size="small" type="info">未接入监控</el-tag>
                  <el-tag v-else-if="evalMap[m.metric_code]?.alarm" size="small" type="danger">告警</el-tag>
                  <el-tag v-else-if="evalMap[m.metric_code]" size="small" type="success">正常</el-tag>
                </div>
                <div class="mono" style="font-size:11px;color:var(--text-3)">{{ m.metric_code }} · {{ m.concept_code }}</div>
                <div style="font-size:12px;color:var(--text-2);margin:6px 0">{{ m.definition }}</div>
                <pre class="sql-block" style="max-height:60px;font-size:11px">{{ m.formula }}</pre>
                <div style="display:flex;align-items:center;gap:8px;margin-top:6px">
                  <span class="stat-val" :class="{ alarm: evalMap[m.metric_code]?.alarm }">{{ evalMap[m.metric_code]?.value ?? m.last_val ?? '—' }}</span>
                  <span style="font-size:11px;color:var(--text-3)">阈值 {{ m.warn_threshold ?? '—' }} · {{ m.owner }}</span>
                  <el-button size="small" text :disabled="!m.probe_sql" @click="evalOne(m)">实测</el-button>
                  <el-button size="small" text :disabled="isViewer" @click="openMetricEdit(m)">编辑</el-button>
                </div>
                <div v-if="evalMap[m.metric_code]?.error" style="font-size:11px;color:var(--danger)">{{ evalMap[m.metric_code].error }}</div>
              </el-card>
            </el-col>
          </el-row>
        </el-card>
      </el-tab-pane>

      <el-tab-pane label="对账" name="reconcile">
        <el-card shadow="never">
          <template #header>
            <div class="card-header"><b>对账组（逐口径实测 → 差额 → 归因桶 → 认领裁决）</b>
              <el-button size="small" type="primary" :disabled="isViewer" @click="recDlg = true">新建对账组</el-button>
            </div>
          </template>
          <el-row :gutter="12">
            <el-col v-for="g in recGroups" :key="g.group_code" :span="12">
              <el-card shadow="hover" class="mb12">
                <div style="display:flex;justify-content:space-between;align-items:center">
                  <b>{{ g.name }}</b>
                  <div>
                    <el-tag size="small" :type="{ OPEN: 'danger', CLAIMED: 'warning', RESOLVED: 'success' }[g.dispute_status]" class="mr4">
                      { OPEN: '待认领', CLAIMED: '对账中', RESOLVED: '已裁决' }[g.dispute_status] || g.dispute_status
                    </el-tag>
                    <el-tag v-if="g.scheduled" size="small" type="info">每日巡检</el-tag>
                  </div>
                </div>
                <div class="mono" style="font-size:11px;color:var(--text-3)">{{ g.group_code }} · 牵头 {{ g.owner || '—' }}</div>
                <div style="font-size:12px;color:var(--text-2);margin:6px 0">{{ g.definition }}</div>
                <div v-if="g.latest">
                  <div v-for="(v, k) in parse(g.latest.values_json)" :key="k" style="display:flex;justify-content:space-between;font-size:13px">
                    <span>{{ k }}</span><b>{{ v }}</b>
                  </div>
                  <div style="display:flex;justify-content:space-between;font-size:13px;margin-top:4px">
                    <b>口径间差额</b>
                    <b :style="{ color: g.latest.diff_value === 0 ? '#10b981' : '#ef4444' }">{{ g.latest.diff_value ?? '算不出' }}</b>
                  </div>
                  <div v-if="g.latest.error_msg" style="font-size:12px;color:var(--warning)">⚠ {{ g.latest.error_msg }}</div>
                  <div v-if="parse(g.latest.buckets_json)?.buckets?.length" class="mb12" style="margin-top:6px">
                    <div style="font-size:12px;color:var(--text-3)">归因拆堆：</div>
                    <div v-for="b in parse(g.latest.buckets_json).buckets" :key="b.label" style="font-size:12px">
                      {{ b.sign > 0 ? '＋' : '－' }} {{ b.label }}：<b>{{ b.count ?? b.error }}</b>
                    </div>
                    <el-tag size="small" :type="parse(g.latest.buckets_json).matchesDiff ? 'success' : 'warning'">
                      {{ parse(g.latest.buckets_json).matchesDiff ? '账对上' : `剩 ${Math.abs(g.latest.diff_value - parse(g.latest.buckets_json).sum)} 笔无归因` }}
                    </el-tag>
                  </div>
                  <div v-if="g.verdict" style="font-size:12px">裁决：{{ g.verdict }}<span style="color:var(--text-3)">（{{ g.resolved_by }} {{ g.verdict_at }}）</span></div>
                  <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
                    <el-button size="small" type="primary" :loading="recRunning === g.group_code" @click="runGroup(g)">跑一次对账</el-button>
                    <el-button v-if="g.dispute_status === 'OPEN'" size="small" :disabled="isViewer" @click="claim(g)">认领</el-button>
                    <el-button v-if="g.dispute_status === 'CLAIMED'" size="small" type="success" :disabled="isViewer" @click="openResolve(g)">裁决</el-button>
                    <el-button size="small" @click="openCompare(g)">直连对照</el-button>
                  </div>
                </div>
                <el-empty v-else description="还没跑过，点「跑一次对账」" :image-size="50" />
              </el-card>
            </el-col>
          </el-row>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="termDlg" title="新增术语" width="460px">
      <el-form label-width="80px">
        <el-form-item label="术语"><el-input v-model="termForm.term" /></el-form-item>
        <el-form-item label="概念"><el-select v-model="termForm.conceptCode" filterable style="width:100%"><el-option v-for="c in conceptStore.concepts" :key="c.code" :label="c.code" :value="c.code" /></el-select></el-form-item>
        <el-form-item label="来源"><el-input v-model="termForm.sourceProduct" placeholder="HIS / LIS / 平台标准" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="termDlg = false">取消</el-button><el-button type="primary" @click="saveTerm">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="metricDlg" title="编辑口径卡" width="560px">
      <el-form label-width="90px">
        <el-form-item label="编码"><el-input :model-value="metricForm.metricCode" disabled class="mono" /></el-form-item>
        <el-form-item label="名称"><el-input v-model="metricForm.name" /></el-form-item>
        <el-form-item label="口径定义"><el-input v-model="metricForm.definition" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="公式"><el-input v-model="metricForm.formula" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="负责人"><el-input v-model="metricForm.owner" /></el-form-item>
        <el-form-item label="探针 SQL"><el-input v-model="metricForm.probeSql" type="textarea" :rows="3" class="mono" /></el-form-item>
        <el-form-item label="数据源"><el-input v-model="metricForm.dsCode" class="mono" /></el-form-item>
        <el-form-item label="告警阈值"><el-input-number v-model="metricForm.warnThreshold" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="metricDlg = false">取消</el-button><el-button type="primary" @click="saveMetricCard">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="recDlg" title="新建对账组" width="640px">
      <el-form label-width="90px">
        <el-form-item label="编码"><el-input v-model="recForm.groupCode" /></el-form-item>
        <el-form-item label="名称"><el-input v-model="recForm.name" /></el-form-item>
        <el-form-item label="业务背景"><el-input v-model="recForm.definition" type="textarea" /></el-form-item>
        <el-form-item label="口径指标（≥2）"><el-select v-model="recForm.metricCodes" multiple style="width:100%"><el-option v-for="m in metrics" :key="m.metric_code" :label="`${m.metric_code} ${m.name}`" :value="m.metric_code" /></el-select></el-form-item>
        <el-form-item label="牵头科室"><el-input v-model="recForm.owner" /></el-form-item>
        <el-form-item label="下钻 SQL"><el-input v-model="recForm.drillSql" type="textarea" :rows="2" class="mono" /></el-form-item>
        <el-form-item label="下钻数据源"><el-input v-model="recForm.drillDsCode" class="mono" /></el-form-item>
        <el-form-item label="挂每日巡检"><el-switch v-model="recForm.scheduled" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="recDlg = false">取消</el-button><el-button type="primary" @click="saveRec">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="resolveDlg" title="裁决入档" width="480px">
      <el-form label-width="90px">
        <el-form-item label="以哪侧为准"><el-input v-model="resolveForm.verdict" placeholder="如：以 HIS 病案口径为准" /></el-form-item>
        <el-form-item label="依据"><el-input v-model="resolveForm.note" type="textarea" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="resolveDlg = false">取消</el-button><el-button type="primary" @click="doResolve">裁决</el-button></template>
    </el-dialog>

    <el-dialog v-model="compareDlg" title="直连数据库方式 vs 本体平台方式" width="920px">
      <el-row :gutter="12" v-if="compareData">
        <el-col :span="12">
          <b>直连数据库（土办法）</b>
          <pre class="json-block">{{ JSON.stringify(compareData.direct, null, 2) }}</pre>
        </el-col>
        <el-col :span="12">
          <b>本体平台</b>
          <div>口径卡 + 运行差额 + 归因桶 + 裁决留痕（对账组对象）</div>
          <div style="margin-top:8px;font-size:12px;color:var(--text-3)">同一张口径卡，谁在读：{{ (compareData.platform?.reusedBy || []).join('、') }}</div>
        </el-col>
      </el-row>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  listTerms, createTerm, deleteTerm, listMetrics, saveMetric, evaluateMetric, evaluateAllMetrics, searchGlossary,
  listReconcile, runReconcile, createReconcile, claimReconcile, resolveReconcile, compareReconcile, listDatasources,
} from '../../api';
import { useUserStore, useConceptStore } from '../../store/user';

const userStore = useUserStore();
const conceptStore = useConceptStore();
const isViewer = computed(() => userStore.isViewer);
const tab = ref('term');
const q = ref(''); const searchResult = ref(null);
const terms = ref([]); const termPage = ref(1); const termDlg = ref(false); const termForm = ref({});
const pagedTerms = computed(() => terms.value.slice((termPage.value - 1) * 20, termPage.value * 20));
const metrics = ref([]); const evalMap = ref({}); const evaluating = ref(false);
const probed = computed(() => metrics.value.filter(m => m.probe_sql).length);
const alarmedCnt = computed(() => Object.values(evalMap.value).filter(e => e.alarm).length);
const metricDlg = ref(false); const metricForm = ref({});
const recGroups = ref([]); const recDlg = ref(false); const recForm = ref({ scheduled: false }); const recRunning = ref('');
const resolveDlg = ref(false); const resolveForm = ref({}); const compareDlg = ref(false); const compareData = ref(null);
const parse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

async function doSearch() { if (q.value) searchResult.value = await searchGlossary(q.value); }
async function evalOne(m) { const r = await evaluateMetric(m.metric_code); evalMap.value[m.metric_code] = r; if (r.alarm) ElMessage.warning(`${m.name} 告警：${r.value} > ${m.warn_threshold}`); }
async function evalAll() {
  evaluating.value = true;
  try { for (const r of await evaluateAllMetrics()) evalMap.value[r.metricCode] = r; ElMessage.success('全量巡检完成'); }
  finally { evaluating.value = false; }
}
function openMetricEdit(m) { metricForm.value = { ...m, warnThreshold: m.warn_threshold }; metricDlg.value = true; }
async function saveMetricCard() { await saveMetric(metricForm.value); metricDlg.value = false; metrics.value = await listMetrics(); }
async function saveTerm() { await createTerm(termForm.value); termDlg.value = false; terms.value = await listTerms(); }
async function delTerm(row) { await deleteTerm(row.id); terms.value = await listTerms(); }
async function runGroup(g) {
  recRunning.value = g.group_code;
  try {
    const r = await runReconcile(g.group_code);
    if (r.diff === 0) ElMessage.success('口径一致，差额 0');
    else if (r.diff == null) ElMessage.info('有口径实测失败，算不出差额');
    else ElMessage.warning(`非零差额 ${r.diff}，工单已打开待认领`);
    recGroups.value = await listReconcile();
  } finally { recRunning.value = ''; }
}
async function claim(g) { await claimReconcile(g.group_code); ElMessage.success('已认领'); recGroups.value = await listReconcile(); }
function openResolve(g) { resolveForm.value = { groupCode: g.group_code }; resolveDlg.value = true; }
async function doResolve() { await resolveReconcile(resolveForm.value.groupCode, resolveForm.value); resolveDlg.value = false; recGroups.value = await listReconcile(); }
async function openCompare(g) { compareData.value = await compareReconcile(g.group_code); compareDlg.value = true; }
async function saveRec() {
  await createReconcile({ ...recForm.value, metricCodes: recForm.value.metricCodes.join(','), bucketsJson: null });
  recDlg.value = false; recGroups.value = await listReconcile();
}
onMounted(async () => {
  terms.value = await listTerms();
  metrics.value = await listMetrics();
  recGroups.value = await listReconcile();
  if (!conceptStore.loaded) await conceptStore.fetchAll();
});
</script>

<style scoped>
.metric-card { min-height: 200px; }
.stat-val { font-size: 22px; font-weight: 700; color: var(--primary); }
.stat-val.alarm { color: var(--danger); }
.mb12 { margin-bottom: 12px; } .mr4 { margin-right: 4px; }
</style>

<template>
  <div class="page">
    <el-alert type="info" :closable="false" class="mb12" title="治理规则挂在本体概念上（GOV-001~012），探针直查业务库，差异落为可处置对象" />
    <el-row :gutter="12" class="mb12">
      <el-col :span="6" v-for="s in statCards" :key="s.label">
        <el-card shadow="never" class="stat-card"><div class="stat-num" :style="{ color: s.color }">{{ s.value }}</div><div class="stat-label">{{ s.label }}</div></el-card>
      </el-col>
    </el-row>
    <el-card shadow="never" class="mb12">
      <template #header><div class="card-header"><b>表治理清单</b><el-button type="primary" size="small" :loading="scanning" :disabled="isViewer" @click="doScan">执行扫描</el-button></div></template>
      <el-table :data="tables" size="small" max-height="360">
        <el-table-column label="库.表" min-width="220"><template #default="{ row }"><span class="mono">{{ row.dsCode }}.{{ row.tableName }}</span></template></el-table-column>
        <el-table-column prop="rowCount" label="数据量" width="90" />
        <el-table-column label="映射覆盖" min-width="160">
          <template #default="{ row }"><el-progress :percentage="row.coverage" :stroke-width="8" /></template>
        </el-table-column>
        <el-table-column prop="domain" label="责任域" width="140" />
        <el-table-column label="健康度" width="90"><template #default="{ row }"><el-tag size="small" :type="row.issueCount ? 'warning' : 'success'">{{ row.issueCount ? '良' : '优' }}</el-tag></template></el-table-column>
        <el-table-column label="未处理问题" width="100"><template #default="{ row }"><span :style="{ color: row.issueCount ? 'var(--danger)' : '' }">{{ row.issueCount }}</span></template></el-table-column>
      </el-table>
    </el-card>
    <el-card shadow="never">
      <template #header><b>问题清单（最近一次扫描：{{ lastScan ? `${lastScan.rule_count} 规则 / 命中 ${lastScan.issue_count} / 质量分 ${lastScan.quality_score}` : '未执行' }}）</b></template>
      <el-table :data="issues" size="small">
        <el-table-column type="expand">
          <template #default="{ row }">
            <pre class="json-block">{{ pretty(row.sample_json) }}</pre>
          </template>
        </el-table-column>
        <el-table-column label="严重度" width="80"><template #default="{ row }"><el-tag size="small" :type="row.severity === '高' ? 'danger' : row.severity === '中' ? 'warning' : 'info'">{{ row.severity }}</el-tag></template></el-table-column>
        <el-table-column label="规则" min-width="220"><template #default="{ row }">{{ row.rule_name }} <span class="mono" style="color:var(--text-3)">{{ row.rule_code }} · {{ row.concept_code }}</span></template></el-table-column>
        <el-table-column prop="rule_type" label="类型" width="140" />
        <el-table-column label="库表" width="200"><template #default="{ row }"><span class="mono">{{ row.ds_code }}.{{ row.table_name }}</span></template></el-table-column>
        <el-table-column prop="hit_count" label="命中数" width="80" />
        <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag size="small" :type="row.status === '未处理' ? 'danger' : 'success'">{{ row.status }}</el-tag></template></el-table-column>
        <el-table-column label="操作" width="200">
          <template #default="{ row }">
            <template v-if="row.status === '未处理'">
              <el-button size="small" text type="primary" :disabled="isViewer" @click="toTicket(row)">转AI客服工单</el-button>
              <el-button size="small" text :disabled="isViewer" @click="resolve(row)">标记已处理</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { govOverview, govTables, govIssues, runGovScan, resolveIssue, issueToTicket } from '../../api';
import { useUserStore } from '../../store/user';

const router = useRouter();
const userStore = useUserStore();
const isViewer = computed(() => userStore.isViewer);
const overview = ref({}); const tables = ref([]); const issues = ref([]); const scanning = ref(false);
const lastScan = computed(() => overview.value.lastScan);
const statCards = computed(() => [
  { label: '物理表', value: overview.value.tableCount, color: '#13c2c2' },
  { label: '映射覆盖率', value: overview.value.coverage + '%', color: '#2d8a7e' },
  { label: '质量分', value: overview.value.qualityScore ?? '—', color: (overview.value.qualityScore ?? 100) >= 90 ? '#10b981' : '#f59e0b' },
  { label: '未处理问题', value: overview.value.openIssues, color: '#ef4444' },
]);
const pretty = (s) => { try { return JSON.stringify(JSON.parse(s || '[]'), null, 2); } catch { return s; } };
async function doScan() {
  scanning.value = true;
  try {
    const r = await runGovScan();
    ElMessage.success(`扫描完成：${r.ruleCount} 规则，命中 ${r.issueCount}，质量分 ${r.qualityScore}（${r.durationMs}ms）`);
    await refresh();
  } finally { scanning.value = false; }
}
async function refresh() {
  overview.value = await govOverview();
  tables.value = await govTables();
  issues.value = (await govIssues({ pageSize: 50 })).list;
}
async function resolve(row) { await resolveIssue(row.id); await refresh(); }
async function toTicket(row) {
  const r = await issueToTicket(row.id);
  if (r.reused) ElMessage.info('已有同规则工单，复用');
  else ElMessage.success(`已建工单 ${r.refNo}`);
  router.push({ path: '/cs', query: { ticketId: r.ticketId } });
}
onMounted(refresh);
</script>

<style scoped>
.stat-card { text-align: center; }
.stat-num { font-size: 24px; font-weight: 700; }
.stat-label { font-size: 12px; color: var(--text-3); }
.mb12 { margin-bottom: 12px; }
</style>

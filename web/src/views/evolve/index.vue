<template>
  <div class="page">
    <el-row :gutter="12" class="mb12">
      <el-col :span="6" v-for="s in statCards" :key="s.label">
        <el-card shadow="never" class="stat-card"><div class="stat-num" :style="{ color: s.color }">{{ s.value }}</div><div class="stat-label">{{ s.label }}</div></el-card>
      </el-col>
    </el-row>
    <el-alert class="mb12" type="info" :closable="false"
      title="增长回路：各业务出口的词表外说法汇入缺口池 → AI 归类/提案 → 人工采纳为草稿 → 评审发布。自动化系统不直接发布任何东西。" />
    <el-card shadow="never" class="mb12">
      <template #header>
        <div class="card-header">
          <el-radio-group v-model="filter" size="small">
            <el-radio-button value="all">全部</el-radio-button>
            <el-radio-button value="pending">待处理</el-radio-button>
            <el-radio-button value="adopted">已采纳</el-radio-button>
            <el-radio-button value="dismissed">已忽略</el-radio-button>
          </el-radio-group>
          <span style="font-size:12px;color:var(--text-3)">深度处置请到 本体管理 → 扩展提案抽屉</span>
        </div>
      </template>
      <div v-for="m in filteredMisses" :key="m.id" class="miss-card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <b>{{ m.term }}</b>
            <el-tag size="small" class="mr4" :type="m.kind === 'CONCEPT' ? 'primary' : m.kind === 'QUESTION' ? 'warning' : 'info'">{{ m.kind }}</el-tag>
            <el-tag size="small" type="info">{{ m.source }}</el-tag>
            <el-tag v-if="m.count >= 3" size="small" type="danger">高热</el-tag>
            <el-tag v-if="m.adopted_concept_code && !m.revoked" size="small" type="success">已采纳 → {{ m.adopted_concept_code }}（{{ m.adopted_as }}）</el-tag>
          </div>
          <div class="miss-count">×{{ m.count }}</div>
        </div>
        <div style="font-size:12px;color:var(--text-3);margin-top:4px">首次 {{ m.first_seen }} · 最近 {{ m.last_seen }}<span v-if="m.dismiss_reason"> · 忽略理由：{{ m.dismiss_reason }}</span></div>
      </div>
      <el-empty v-if="!filteredMisses.length" description="暂无缺口" />
    </el-card>

    <el-card shadow="never" class="mb12">
      <template #header>
        <div class="card-header"><b>AI 提案队列（L2 分层自治）</b>
          <el-button size="small" type="primary" :disabled="isViewer" :loading="running" @click="gen">生成提案</el-button>
        </div>
      </template>
      <el-table :data="proposals" size="small">
        <el-table-column type="expand">
          <template #default="{ row }">
            <pre class="json-block">{{ pretty(row.suggestion_json) }}</pre>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag size="small" :type="{ PENDING: 'warning', ADOPTED: 'success', REJECTED: 'info' }[row.status]">{{ row.status }}</el-tag></template></el-table-column>
        <el-table-column prop="term" label="代表说法" min-width="140" />
        <el-table-column prop="signal_count" label="热度" width="70" />
        <el-table-column label="AI 判定" min-width="180">
          <template #default="{ row }"><el-tag size="small" class="mr4" :type="row.action === 'NEW_CONCEPT' ? 'success' : 'primary'">{{ row.action === 'NEW_CONCEPT' ? '新建概念' : '挂靠术语' }}</el-tag>{{ row.target_concept_code }}</template>
        </el-table-column>
        <el-table-column prop="decided_by" label="裁决人" width="90" />
        <el-table-column label="操作" width="150">
          <template #default="{ row }">
            <template v-if="row.status === 'PENDING'">
              <el-button size="small" text type="success" :disabled="isViewer" @click="adopt(row)">采纳</el-button>
              <el-button size="small" text type="danger" :disabled="isViewer" @click="reject(row)">驳回</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card v-if="!isViewer" shadow="never">
      <template #header><b>澄清任务（A 型歧义证据，仅管理员/建模员可见）</b></template>
      <el-table :data="clarifyTasks" size="small">
        <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag size="small" :type="{ PENDING: 'warning', GAVE_UP: 'danger', RESOLVED: 'success' }[row.status]">{{ row.status }}</el-tag></template></el-table-column>
        <el-table-column prop="origin_question" label="原问题" min-width="180" show-overflow-tooltip />
        <el-table-column prop="clarify_question" label="AI 缺什么" min-width="180" show-overflow-tooltip />
        <el-table-column prop="supplement" label="用户补充" min-width="140" show-overflow-tooltip />
        <el-table-column prop="rounds" label="轮次" width="60" />
        <el-table-column prop="miss_id" label="回流缺口" width="80" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { listMisses, listProposals, runProposal, adoptProposal, rejectProposal, listClarify } from '../../api';
import { useUserStore } from '../../store/user';

const userStore = useUserStore();
const isViewer = computed(() => userStore.isViewer);
const misses = ref([]); const filter = ref('pending');
const proposals = ref([]); const running = ref(false); const clarifyTasks = ref([]);
const pendingCnt = computed(() => misses.value.filter(m => !m.dismissed && !m.revoked && (!m.adopted_concept_code || m.revoked)).length);
const adoptedCnt = computed(() => misses.value.filter(m => m.adopted_concept_code && !m.revoked).length);
const dismissedCnt = computed(() => misses.value.filter(m => m.dismissed).length);
const hotCnt = computed(() => Math.max(0, ...misses.value.map(m => m.count)));
const statCards = computed(() => [
  { label: '待处理缺口', value: pendingCnt.value, color: '#f59e0b' },
  { label: '已采纳', value: adoptedCnt.value, color: '#10b981' },
  { label: '已忽略', value: dismissedCnt.value, color: '#94a3b8' },
  { label: '最高热度', value: hotCnt.value, color: '#ef4444' },
]);
const filteredMisses = computed(() => {
  if (filter.value === 'pending') return misses.value.filter(m => !m.dismissed && !m.revoked && (!m.adopted_concept_code || m.revoked));
  if (filter.value === 'adopted') return misses.value.filter(m => m.adopted_concept_code && !m.revoked);
  if (filter.value === 'dismissed') return misses.value.filter(m => m.dismissed);
  return misses.value;
});
const pretty = (s) => { try { return JSON.stringify(JSON.parse(s || '{}'), null, 2); } catch { return s; } };
async function load() {
  const r = await listMisses();
  misses.value = r.list;
  proposals.value = await listProposals('ALL');
  if (!isViewer.value) clarifyTasks.value = await listClarify();
}
async function gen() {
  running.value = true;
  try { const r = await runProposal(); ElMessage.success(`扫描 ${r.scanned}，生成 ${r.generated}，LLM 失败 ${r.llmFailed}`); await load(); }
  finally { running.value = false; }
}
async function adopt(row) { await adoptProposal(row.id); ElMessage.success('已采纳为 DRAFT'); await load(); }
async function reject(row) {
  const { value } = await ElMessageBox.prompt('驳回理由', '驳回（驳回的是提案，不是信号）');
  await rejectProposal(row.id, value); await load();
}
onMounted(load);
</script>

<style scoped>
.stat-card { text-align: center; }
.stat-num { font-size: 24px; font-weight: 700; }
.stat-label { font-size: 12px; color: var(--text-3); }
.miss-card { border: 1px solid #eef2f5; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; }
.miss-count { font-size: 20px; font-weight: 700; color: var(--warning); }
.mb12 { margin-bottom: 12px; } .mr4 { margin-right: 4px; }
</style>

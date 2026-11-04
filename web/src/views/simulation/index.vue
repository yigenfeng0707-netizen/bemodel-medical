<template>
  <div class="page">
    <el-alert class="mb12" type="info" :closable="false" title="推演沙盘在独立沙盒库上施加扰动并沿本体关系传导，演示数据不碰真实库；跑完自动复原。" />
    <el-card shadow="never" class="mb12">
      <template #header><b>动手改：库存断供传导</b></template>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <el-select v-model="scenario" style="width:200px">
          <el-option v-for="s in scenarios" :key="s.key" :label="s.name" :value="s.key" />
        </el-select>
        <el-input v-model="drugCode" placeholder="药品编码 D006" style="width:150px" />
        <span>库存改为</span>
        <el-input-number v-model="quantity" :min="0" />
        <el-button type="primary" :loading="running" @click="start">开始推演</el-button>
        <el-button @click="reset">恢复演示数据</el-button>
      </div>
    </el-card>
    <el-card v-if="run" shadow="never" class="mb12">
      <template #header><b>波及链（本体传导）</b></template>
      <div v-for="level in levels" :key="level.n" class="level">
        <el-tag size="small" type="info" class="mr4">第 {{ level.n }} 层</el-tag>
        <div v-for="s in level.items" :key="s.concept" class="node-card" :class="s.status?.toLowerCase()">
          <div style="display:flex;justify-content:space-between">
            <b class="mono">{{ s.concept }}</b>
            <el-tag size="small" :type="nodeTag(s.status)">{{ statusText(s) }}</el-tag>
          </div>
          <div style="font-size:12px;color:var(--text-2)">{{ s.note }}</div>
          <div style="font-size:11px;color:var(--text-3)" class="mono">{{ (s.mappingRefs || []).join('，') }}</div>
        </div>
      </div>
      <template v-if="run.payload?.diff">
        <div class="mb12" style="margin-top:10px"><b>前后对比</b></div>
        <el-table :data="run.payload.diff.items" size="small">
          <el-table-column prop="name" label="观察面" />
          <el-table-column prop="before" label="推演前" width="140" />
          <el-table-column prop="after" label="推演后" width="140" />
        </el-table>
      </template>
    </el-card>
    <el-card shadow="never">
      <template #header><b>最近推演</b></template>
      <el-table :data="runs" size="small" @row-click="(r) => loadRun(r.id)">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="scenario" label="场景" width="140" />
        <el-table-column prop="status" label="状态" width="100" />
        <el-table-column prop="created_at" label="时间" width="170" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { simScenarios, simStart, simStatus, simRuns, simReset } from '../../api';

const scenarios = ref([]); const scenario = ref('STOCK_CUT');
const drugCode = ref('D006'); const quantity = ref(0);
const running = ref(false); const run = ref(null); const runs = ref([]);
const levels = computed(() => {
  const map = {};
  for (const s of run.value?.payload?.steps || []) (map[s.level] = map[s.level] || []).push(s);
  return Object.entries(map).map(([n, items]) => ({ n, items })).sort((a, b) => a.n - b.n);
});
const nodeTag = (s) => ({ DONE: 'success', BLOCKED_GAP: 'warning', EMPTY: 'info' }[s] || 'info');
const statusText = (s) => ({ DONE: `${s.samples?.length ?? ''} 条`, BLOCKED_GAP: '到此为止', EMPTY: '查无实例' }[s.status] || s.status);
async function start() {
  running.value = true;
  try {
    const r = await simStart({ drugCode: drugCode.value, quantity: quantity.value });
    for (let i = 0; i < 30; i++) {
      run.value = await simStatus(r.runId);
      if (['DONE', 'FAILED'].includes(run.value.status)) break;
      await new Promise(s => setTimeout(s, 1500));
    }
    runs.value = await simRuns();
  } finally { running.value = false; }
}
async function loadRun(id) { run.value = await simStatus(id); }
async function reset() { await simReset(); }
onMounted(async () => { scenarios.value = await simScenarios(); runs.value = await simRuns(); });
</script>

<style scoped>
.level { margin-bottom: 10px; }
.node-card { display: inline-block; vertical-align: top; border: 1px solid #eef2f5; border-radius: 10px; padding: 8px 12px; margin: 4px 8px 4px 0; min-width: 220px; }
.node-card.done { border-color: var(--success); }
.node-card.blocked_gap { border-color: var(--warning); }
.node-card.empty { opacity: .6; }
.mb12 { margin-bottom: 12px; } .mr4 { margin-right: 4px; }
:deep(.el-table__row) { cursor: pointer; }
</style>

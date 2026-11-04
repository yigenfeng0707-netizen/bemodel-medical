<template>
  <div class="page">
    <el-card shadow="never" class="mb12">
      <el-input v-model="question" type="textarea" :rows="2" maxlength="500" placeholder="三臂同题：A=AI+本体（规则约束），B=AI+裸SQL，C=传统固定系统" />
      <div style="display:flex;gap:10px;align-items:center;margin-top:8px">
        <el-switch v-model="forceExecute" active-text="B 组必须执行（不许拒绝）" inactive-text="B 组自行判断" />
        <el-button type="primary" :loading="running" :disabled="!question" @click="start">开始对比</el-button>
        <el-button @click="resetSandbox">重置演示数据</el-button>
        <el-button @click="auditOpen = !auditOpen">数据核查</el-button>
      </div>
      <div v-if="auditOpen && audit" class="mb12" style="margin-top:10px">
        <el-alert v-for="a in audit" :key="a.key" :type="a.hits ? 'error' : 'success'" :closable="false" class="mb12"
          :title="`${a.desc}：命中 ${a.hits}${a.govRule ? '（' + a.govRule + '）' : ''}`" />
      </div>
    </el-card>
    <el-row v-if="run" :gutter="12" class="mb12">
      <el-col v-for="(arm, key) in arms" :key="key" :span="8">
        <el-card shadow="never" :class="['arm-card', key]">
          <template #header><b>{{ arm.title }}</b></template>
          <template v-if="run.payload?.[key]">
            <div style="font-size:12px;color:var(--text-3)">
              状态：<el-tag size="small" :type="statusTag(run.payload[key].status)">{{ run.payload[key].status }}</el-tag>
              · LLM {{ run.payload[key].llmCalls ?? 0 }} 次 · {{ Math.round((run.payload[key].elapsedMs || 0) / 100) / 10 }}s
            </div>
            <div v-if="run.payload[key].anchorsCited?.length" class="mb12" style="margin-top:6px">
              <el-tag v-for="a in run.payload[key].anchorsCited" :key="a" size="small" type="success" class="mr4">{{ a }}</el-tag>
            </div>
            <div v-if="key === 'a' && !run.payload[key].anchorsCited?.length" class="mb12" style="color:var(--warning);font-size:12px">⚠ 约束没起作用（无锚点）</div>
            <pre class="answer-pre">{{ run.payload[key].answer || '…' }}</pre>
            <el-collapse>
              <el-collapse-item title="AI 作答过程">
                <div v-for="(s, i) in run.payload[key].steps || []" :key="i" class="step-line">
                  <el-tag size="small" :type="s.kind === 'TOOL' ? 'success' : s.kind === 'FINAL' ? 'primary' : 'danger'" class="mr4">{{ s.kind }}</el-tag>
                  <span v-if="s.tool" class="mono">{{ s.tool }}</span>
                  <pre v-if="s.sql" class="sql-block">{{ s.sql }}</pre>
                  <pre v-if="s.result !== undefined" class="json-block">{{ pretty(s.result) }}</pre>
                  <div v-if="s.answer" style="font-size:12px">{{ s.answer }}</div>
                </div>
              </el-collapse-item>
            </el-collapse>
          </template>
          <el-skeleton v-else :rows="4" animated />
        </el-card>
      </el-col>
    </el-row>
    <el-card shadow="never">
      <template #header><b>最近运行</b></template>
      <el-table :data="runs" size="small" @row-click="(r) => loadRun(r.id)">
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column label="场景" width="140">
          <template #default="{ row }">{{ { GATE: '过敏用药拦截', ADVERSARIAL: '越权改库存', REFUND: '批量正规退费', TRAVERSE: '跨系统足迹', FREE: '自由提问' }[row.experiment_key] }}</template>
        </el-table-column>
        <el-table-column prop="question" label="问题" show-overflow-tooltip />
        <el-table-column prop="status" label="状态" width="100" />
        <el-table-column prop="created_at" label="时间" width="170" />
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { listExperiments, labStart, labStatus, labRuns, labReset, labAudit } from '../../api';

const route = useRoute();
const experiments = ref([]); const question = ref(''); const forceExecute = ref(true);
const running = ref(false); const run = ref(null); const runs = ref([]);
const auditOpen = ref(false); const audit = ref(null);
const arms = { a: { title: 'A 组 · AI+本体（规则约束）' }, b: { title: 'B 组 · AI 直接操作数据库' }, c: { title: 'C 组 · 人工开发固定页面' } };
const statusTag = (s) => ({ DONE: 'success', BUDGET_CUT: 'warning', FORMAT_FAILED: 'danger', LLM_UNAVAILABLE: 'info', RUNNING: 'primary' }[s] || 'info');
const pretty = (o) => { try { return JSON.stringify(typeof o === 'string' ? JSON.parse(o) : o, null, 2).slice(0, 600); } catch { return String(o); } };

async function start() {
  running.value = true;
  try {
    const r = await labStart({ question: question.value, forceExecute: forceExecute.value });
    await poll(r.runId);
  } finally { running.value = false; }
}
async function poll(runId) {
  for (let i = 0; i < 90; i++) {
    const r = await labStatus(runId);
    run.value = r;
    if (['DONE', 'FAILED'].includes(r.status)) break;
    await new Promise(s => setTimeout(s, 2000));
  }
  runs.value = await labRuns();
  if ((JSON.stringify(run.value?.payload?.a?.steps || '') + JSON.stringify(run.value?.payload?.b?.steps || '')).match(/update|insert|delete/i)) {
    ElMessage.warning('本组改动过演示数据，请点「重置演示数据」后继续');
  }
}
async function loadRun(id) { run.value = await labStatus(id); }
async function resetSandbox() { await ElMessageBox.confirm('重置沙盒为初始演示数据？', '重置'); await labReset(); ElMessage.success('已重置'); }
onMounted(async () => {
  experiments.value = await listExperiments();
  runs.value = await labRuns();
  if (route.query.exp) {
    const e = experiments.value.find(x => x.key === route.query.exp);
    if (e) question.value = e.question;
  }
});
</script>

<style scoped>
.arm-card.a { border-top: 3px solid var(--success); }
.arm-card.b { border-top: 3px solid var(--warning); }
.arm-card.c { border-top: 3px solid var(--text-3); }
.answer-pre { white-space: pre-wrap; font-size: 12px; background: #f8fafc; border-radius: 8px; padding: 8px 10px; max-height: 200px; overflow: auto; }
.step-line { margin-bottom: 8px; }
.mb12 { margin-bottom: 12px; } .mr4 { margin-right: 4px; }
</style>

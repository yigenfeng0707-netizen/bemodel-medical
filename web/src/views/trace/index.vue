<template>
  <div class="page">
    <el-card shadow="never" class="mb12">
      <div style="display:flex;gap:10px;align-items:center">
        <el-select v-model="type" style="width:160px">
          <el-option label="问数答案（QA）" value="QA" />
          <el-option label="概念（CONCEPT）" value="CONCEPT" />
          <el-option label="映射（MAPPING）" value="MAPPING" />
        </el-select>
        <el-input v-model="key" :placeholder="keyPlaceholder" style="width:320px" @keyup.enter="query" />
        <el-button type="primary" @click="query">查证据链</el-button>
      </div>
    </el-card>
    <el-card v-if="trace" shadow="never">
      <div class="trace-summary mb12">
        <el-tag>{{ typeText }}</el-tag>
        <span class="mono">{{ trace.key }}</span>
        <span>{{ trace.summary }}</span>
      </div>
      <div class="mb12"><b>排查路径</b></div>
      <el-timeline class="mb12">
        <el-timeline-item v-for="s in trace.spans" :key="s.step" :timestamp="`${s.actor} · ${s.at}`">
          <b>{{ s.title }}</b>
          <div style="font-size:13px;color:var(--text-2);white-space:pre-wrap">{{ s.detail }}</div>
        </el-timeline-item>
      </el-timeline>
      <div class="mb12"><b>证据锚点</b></div>
      <div class="mb12">
        <el-button v-for="a in trace.anchors" :key="a.route" size="small" @click="$router.push(a.route)">{{ a.label }}</el-button>
      </div>
      <template v-if="trace.actions?.length">
        <div class="mb12"><b>建议动作</b></div>
        <ol style="font-size:13px"><li v-for="a in trace.actions" :key="a.label"><el-link @click="$router.push(a.route)">{{ a.label }}</el-link></li></ol>
      </template>
    </el-card>
    <el-empty v-else-if="queried" description="未找到证据链" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { getTrace } from '../../api';

const route = useRoute();
const type = ref('QA'); const key = ref(''); const trace = ref(null); const queried = ref(false);
const typeText = computed(() => ({ QA: '问数答案', CONCEPT: '概念', MAPPING: '映射' }[type.value]));
const keyPlaceholder = computed(() => ({ QA: '输入 traceId，如 QA-1730…', CONCEPT: '概念编码，如 FEE_DETAIL', MAPPING: '映射 ID（数字）' }[type.value]));
async function query() {
  try { trace.value = await getTrace(type.value, key.value); }
  catch { trace.value = null; }
  queried.value = true;
}
onMounted(() => {
  if (route.query.type) type.value = route.query.type;
  if (route.query.key) { key.value = route.query.key; query(); }
});
</script>

<style scoped>
.trace-summary { display: flex; gap: 10px; align-items: center; font-size: 14px; }
.mb12 { margin-bottom: 12px; }
</style>

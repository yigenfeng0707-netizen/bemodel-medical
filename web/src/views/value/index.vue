<template>
  <div class="page">
    <el-alert class="mb12" type="info" :closable="false"
      title="判断标准：同一个问题，AI+本体 / AI+裸SQL / 传统固定系统 三种方式的差异，全部实测不粉饰。" />
    <el-card shadow="never" class="mb12">
      <template #header><b>MCP 开放（只读端点）</b></template>
      <div class="mono mb12" style="background:#f8fafc;padding:10px;border-radius:8px">claude mcp add --transport http bemodel http://localhost:18080/mcp</div>
      <div style="display:flex;gap:12px">
        <el-tag>ask_data_question：把中文数据问题交给语义层</el-tag>
        <el-tag type="success">get_metric_card：取口径卡并探针实测</el-tag>
        <el-tag type="warning">演示期未启用鉴权</el-tag>
      </div>
    </el-card>
    <el-card shadow="never" class="mb12">
      <template #header><b>推演沙盘</b>
        <el-button size="small" type="primary" @click="$router.push('/simulation')">进入推演沙盘</el-button>
      </template>
      <span style="font-size:13px;color:var(--text-2)">施加"库存断供"扰动，沿本体关系观察波及链与前后对比（演示数据，不碰真实库）。</span>
    </el-card>
    <el-row :gutter="12">
      <el-col v-for="e in data.experiments || []" :key="e.key" :span="12">
        <el-card shadow="hover" class="mb12">
          <b>{{ e.title }}</b>
          <div class="q-line">「{{ e.question }}」</div>
          <div class="arm arm-a"><b>A · AI+本体：</b>{{ e.a }}</div>
          <div class="arm arm-b"><b>B · AI+裸SQL：</b>{{ e.b }}</div>
          <div class="arm arm-c"><b>C · 传统系统：</b>{{ e.c }}</div>
          <el-button size="small" type="primary" plain @click="goLab(e.key)">去 AI 查询比对真跑</el-button>
        </el-card>
      </el-col>
    </el-row>
    <el-card v-if="data.llmSummary" shadow="never">
      <template #header><b>LLM 价值总结</b></template>
      {{ data.llmSummary }}
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { valueCompare } from '../../api';

const router = useRouter();
const data = ref({});
const LAB_KEY = { GATE: 'GATE', SILO: 'REFUND', ADVERSARIAL: 'ADVERSARIAL', TRAVERSE: 'TRAVERSE' };
function goLab(key) { router.push(`/lab?exp=${LAB_KEY[key] || 'FREE'}`); }
onMounted(async () => { data.value = await valueCompare(); });
</script>

<style scoped>
.q-line { font-size: 13px; color: var(--text-2); margin: 6px 0; }
.arm { font-size: 12px; border-radius: 8px; padding: 8px 10px; margin-bottom: 6px; }
.arm-a { background: #f0faf7; } .arm-b { background: #fffaf0; } .arm-c { background: #f8fafc; }
.mb12 { margin-bottom: 12px; } .mr4 { margin-right: 4px; }
</style>

<template>
  <div class="page">
    <el-card shadow="never" class="mb12">
      <div class="card-header">
        <div>
          <el-tag v-if="scan.termConflicts?.length" type="danger" class="mr4">术语分叉 {{ scan.termConflicts.length }}</el-tag>
          <el-tag v-if="scan.calibreChanges?.length" type="warning" class="mr4">口径演进 {{ scan.calibreChanges.length }}</el-tag>
          <el-tag type="info">扫描术语 {{ scan.stats?.scannedTerms }} · 发布版本 {{ scan.stats?.scannedReleases }}</el-tag>
        </div>
        <el-button type="primary" size="small" @click="doScan">重新扫描</el-button>
      </div>
    </el-card>
    <el-card shadow="never" class="mb12">
      <template #header><b>术语分叉（同一个词在各系统里指的不是同一件事）</b></template>
      <div v-for="c in scan.termConflicts || []" :key="c.term" class="conflict-card">
        <b>「{{ c.term }}」</b><el-tag size="small" type="danger" class="mr4">挂到 {{ c.conceptCount }} 个概念</el-tag>
        <div v-for="u in c.usages" :key="u.conceptCode" style="font-size:12px;margin-top:4px">
          <el-tag size="small" type="success" class="mr4">{{ u.conceptCode }}</el-tag>{{ u.conceptName }}
          <span style="color:var(--text-3)">（{{ u.sourceProduct }} · {{ u.termType }}{{ u.codeSystem ? ` · ${u.codeSystem}` : '' }}）</span>
        </div>
        <el-button size="small" text type="primary" @click="$router.push('/glossary')">去统一口径处置</el-button>
      </div>
      <el-empty v-if="!scan.termConflicts?.length" description="未检测到术语分叉" :image-size="60" />
    </el-card>
    <el-card shadow="never">
      <template #header><b>口径演进（相邻发布版本快照对比）</b></template>
      <div v-for="c in scan.calibreChanges || []" :key="c.toReleaseId + c.code + c.field" class="calibre-item">
        <el-tag size="small" type="success" class="mr4">{{ c.versionTag }}</el-tag>
        <el-tag size="small" class="mr4">{{ c.kind }}</el-tag>
        <b class="mono">{{ c.code }}</b>（{{ c.name }}）的 <b>{{ c.field }}</b> 变更
        <div class="diff-line"><span class="old">{{ c.oldVal }}</span> → <span class="new">{{ c.newVal }}</span></div>
      </div>
      <el-empty v-if="!scan.calibreChanges?.length" description="暂无口径演进记录（发布新版本后此处对比快照）" :image-size="60" />
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { scanDrift } from '../../api';

const scan = ref({});
async function doScan() { scan.value = await scanDrift(); }
onMounted(doScan);
</script>

<style scoped>
.conflict-card { border: 1px solid #fde2e2; border-radius: 10px; padding: 10px 14px; margin-bottom: 10px; background: #fffafa; }
.calibre-item { border-left: 3px solid var(--warning); padding: 8px 12px; margin-bottom: 10px; background: #fffdf5; border-radius: 0 8px 8px 0; }
.diff-line { font-size: 12px; margin-top: 4px; }
.old { color: var(--danger); text-decoration: line-through; }
.new { color: var(--success); }
.mb12 { margin-bottom: 12px; } .mr4 { margin-right: 4px; }
</style>

<template>
  <div class="page">
    <div class="stat-row mb12">
      <el-card v-for="s in stats" :key="s.label" class="stat-card" shadow="never">
        <div class="stat-num" :style="{ color: s.color }">{{ s.value }}</div>
        <div class="stat-label">{{ s.label }}</div>
      </el-card>
    </div>
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <el-radio-group v-model="viewMode">
            <el-radio-button value="entities">实体全景</el-radio-button>
            <el-radio-button value="layers">分层架构</el-radio-button>
          </el-radio-group>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <el-checkbox-group v-model="visibleTypes" size="small">
              <el-checkbox v-for="t in TYPE_OPTIONS" :key="t.value" :value="t.value">
                <span :style="{ color: t.color }">●</span> {{ t.label }}
              </el-checkbox>
            </el-checkbox-group>
            <el-switch v-model="onlyUnmapped" active-text="只看未映射概念" />
            <el-input v-model="keyword" placeholder="搜索节点…" clearable style="width:200px" size="small" />
          </div>
        </div>
      </template>
      <div v-if="viewMode === 'entities'" class="graph-tip">拖拽平移 · 滚轮缩放 · 点节点跳转对应页面</div>
      <GraphCanvas v-if="viewMode === 'entities'" :nodes="graphNodes" :edges="graphEdges" layout="none" :height="chartHeight" :tooltip-formatter="tip" @node-click="onNodeClick" />
      <div v-else class="layers">
        <div v-for="layer in LAYERS" :key="layer.title" class="layer-col">
          <div class="layer-title" :style="{ background: layer.color }">{{ layer.title }}</div>
          <div v-for="n in layer.items" :key="n.label" class="layer-node" @click="n.route && $router.push(n.route)">
            <b>{{ n.label }}</b><span>{{ n.desc }}</span>
          </div>
        </div>
        <div class="layer-arrows">→ 语义逐层向上收敛，物理逐层向下自治 →</div>
      </div>
    </el-card>
    <el-card shadow="never" class="mb12" style="margin-top:12px">
      <div class="value-cards">
        <div class="vc"><b>数据治理</b><span>字典一致、账实相符、引用完整 → 探针自动巡检</span></div>
        <div class="vc"><b>业务流程</b><span>医嘱→申请→报告→费用→结算 闭环可追溯</span></div>
        <div class="vc"><b>研发效率</b><span>新问题 = 本体建模，不是新页面</span></div>
        <div class="vc"><b>AI 赋能</b><span>LLM 沿本体推理，白名单沙箱内真执行</span></div>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { architectureOverview } from '../../api';
import GraphCanvas from '../../components/GraphCanvas.vue';

const router = useRouter();
const data = ref({ nodes: [], edges: [] });
const viewMode = ref('entities');
const keyword = ref('');
const onlyUnmapped = ref(false);

const TYPE_STYLE = {
  DOMAIN: { color: '#409eff', size: 18 }, CONCEPT: { color: '#67c23a', size: 13 }, RULE: { color: '#e6a23c', size: 12 },
  METRIC: { color: '#722ed1', size: 12 }, TABLE: { color: '#13c2c2', size: 10 }, DATASOURCE: { color: '#f56c6c', size: 18 },
};
const TYPE_OPTIONS = [
  { value: 'DOMAIN', label: '业务域', color: '#409eff' },
  { value: 'CONCEPT', label: '概念', color: '#67c23a' },
  { value: 'RULE', label: '规则', color: '#e6a23c' },
  { value: 'METRIC', label: '指标', color: '#722ed1' },
  { value: 'DATASOURCE', label: '数据源', color: '#f56c6c' },
  { value: 'TABLE', label: '物理表', color: '#13c2c2' },
];
const visibleTypes = ref(['DOMAIN', 'CONCEPT', 'RULE', 'METRIC', 'DATASOURCE']);
const layerOf = (n) => Math.min(4, Math.max(1, n.layer || 1));
const stats = computed(() => {
  const n = data.value.nodes;
  const cnt = (t) => n.filter(x => x.type === t).length;
  const concepts = n.filter(x => x.type === 'CONCEPT');
  const mapped = concepts.filter(c => (c.stats?.mappingCount || 0) > 0).length;
  const cov = concepts.length ? Math.round((100 * mapped) / concepts.length) : 0;
  return [
    { label: '概念', value: cnt('CONCEPT'), color: '#67c23a' },
    { label: '关系', value: data.value.edges.filter(e => e.kind === 'RELATION').length, color: '#67c23a' },
    { label: '数据源', value: cnt('DATASOURCE'), color: '#f56c6c' },
    { label: '物理表', value: cnt('TABLE'), color: '#13c2c2' },
    { label: '映射覆盖度', value: cov + '%', color: cov >= 80 ? '#67c23a' : cov >= 50 ? '#f59e0b' : '#ef4444' },
    { label: '规则', value: cnt('RULE'), color: '#e6a23c' },
    { label: '指标', value: cnt('METRIC'), color: '#722ed1' },
  ];
});
const graphNodes = computed(() => {
  const kept = data.value.nodes
    .filter(n => visibleTypes.value.includes(n.type))
    .filter(n => !onlyUnmapped.value || n.type !== 'CONCEPT' || !(n.stats?.mappingCount > 0));
  const byLayer = {};
  kept.forEach(n => { (byLayer[layerOf(n)] = byLayer[layerOf(n)] || []).push(n); });
  const maxCount = Math.max(1, ...Object.values(byLayer).map(a => a.length));
  const rowGap = 36;
  return kept.map(n => {
    const arr = byLayer[layerOf(n)];
    const idx = arr.indexOf(n);
    const y = 400 - ((arr.length - 1) * rowGap) / 2 + idx * rowGap;
    const st = TYPE_STYLE[n.type] || { color: '#999', size: 10 };
    const dim = keyword.value && !(n.name || '').includes(keyword.value) && !(n.code || '').includes(keyword.value);
    return {
      id: n.id, name: n.name || n.code,
      x: 140 + (layerOf(n) - 1) * 340, y,
      symbolSize: st.size + (n.type === 'CONCEPT' ? Math.min(8, n.stats?.mappingCount || 0) : 0),
      itemStyle: { color: st.color, opacity: dim ? 0.15 : 1 },
      label: { show: n.type !== 'TABLE', color: dim ? '#c0c8d0' : '#1a2332', fontSize: n.type === 'DOMAIN' || n.type === 'DATASOURCE' ? 13 : 11 },
      emphasis: { label: { show: true } },
      raw: n,
    };
  });
});
const chartHeight = computed(() => {
  if (viewMode.value !== 'entities') return '620px';
  const byLayer = {};
  data.value.nodes.filter(n => visibleTypes.value.includes(n.type)).forEach(n => { (byLayer[layerOf(n)] = byLayer[layerOf(n)] || []).push(n); });
  const maxCount = Math.max(1, ...Object.values(byLayer).map(a => a.length));
  return `${Math.max(620, maxCount * 40 + 120)}px`;
});
const graphEdges = computed(() => data.value.edges
  .filter(e => graphNodes.value.find(n => n.id === e.from) && graphNodes.value.find(n => n.id === e.to))
  .map(e => ({
    source: e.from, target: e.to,
    lineStyle: { color: EDGE_COLOR[e.kind] || '#ccc', width: 1, type: e.axioms?.includes('transitive') ? 'dashed' : 'solid', opacity: keyword.value ? 0.25 : 0.8 },
    label: { show: e.kind === 'RELATION', formatter: e.names, fontSize: 9 },
    raw: e,
  })));
const EDGE_COLOR = { BELONG: '#c0d4e8', RELATION: '#67c23a', MAPPING: '#13c2c2', DS_TABLE: '#f56c6c', RULE_BIND: '#e6a23c', METRIC_BIND: '#722ed1' };

function tip(p) {
  if (p.dataType === 'edge') {
    const r = p.data.raw;
    return `${r.names || r.kind}${r.inverseOf ? ' ⇄ ' + r.inverseOf : ''}<br/>${r.kind}`;
  }
  const r = p.data.raw;
  if (r.type === 'CONCEPT') return `${r.code}（${r.name}）<br/>域：${r.domainCode}｜状态：${r.status}<br/>生效映射表：${r.stats?.mappingCount || 0}`;
  if (r.type === 'TABLE') return `物理表 ${r.id.slice(2)}<br/>数据源：${r.dsCode}`;
  return `${r.name || r.code}<br/>${r.type}`;
}
function onNodeClick(d) {
  const r = d.raw;
  if (r.type === 'CONCEPT') router.push(`/ontology?concept=${r.code}`);
  else if (r.type === 'DOMAIN') router.push(`/ontology?domain=${r.code}`);
  else if (r.type === 'RULE') router.push('/ontology?tab=rule');
  else if (r.type === 'METRIC') router.push('/glossary');
  else if (r.type === 'DATASOURCE') router.push('/datasource');
  else if (r.type === 'TABLE') router.push(`/datasource?ds=${r.dsCode}`);
}
const LAYERS = [
  { title: 'L1 本体层', color: '#e6f2f0', items: [
    { label: '业务域 / 概念', desc: '16 域 · 44+ 概念 · 多父继承', route: '/ontology' },
    { label: '关系与公理', desc: '对称/传递/函数/互斥/互逆', route: '/ontology' },
    { label: '术语对齐', desc: '方言 → 标准概念', route: '/glossary' },
  ] },
  { title: 'L2 规范层', color: '#fff7e8', items: [
    { label: '业务规则', desc: '约束/推导/校验 + QC 引擎', route: '/ontology?tab=rule' },
    { label: '指标口径', desc: '口径卡 = 口径+公式+探针', route: '/glossary' },
    { label: '发布门禁', desc: '缺陷自检 + 版本快照', route: '/ontology?tab=release' },
  ] },
  { title: 'L3 语义映射层', color: '#e8f7ff', items: [
    { label: '概念 ↔ 物理列', desc: '映射生命周期 + 值字典', route: '/datasource' },
    { label: 'AI 推荐绑定', desc: '列 → 概念属性建议', route: '/datasource' },
    { label: '治理探针', desc: '五类规则自动扫描', route: '/gov' },
  ] },
  { title: 'L4 物理层', color: '#fdeaea', items: [
    { label: '九套业务库', desc: 'HIS/LIS/收费/药房/EMR…', route: '/datasource' },
    { label: '数据不搬家', desc: '只读连接 + 白名单探针', route: '/flow' },
    { label: 'AI 沙盒', desc: '三臂对照 / 推演沙盘', route: '/lab' },
  ] },
];
onMounted(async () => { data.value = await architectureOverview(); });
</script>

<style scoped>
.stat-row { display: flex; gap: 12px; }
.stat-card { flex: 1; text-align: center; }
.stat-num { font-size: 24px; font-weight: 700; }
.stat-label { font-size: 12px; color: var(--text-3); }
.layers { display: flex; gap: 12px; position: relative; padding: 8px 0; }
.layer-col { flex: 1; border-radius: 12px; padding: 10px; }
.layer-title { font-weight: 700; font-size: 13px; padding: 6px 10px; border-radius: 8px; margin-bottom: 10px; }
.layer-node { background: #fff; border: 1px solid #eef2f5; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; cursor: pointer; transition: var(--transition); }
.layer-node:hover { border-color: var(--primary); transform: translateY(-2px); }
.layer-node b { display: block; font-size: 13px; }
.layer-node span { font-size: 11px; color: var(--text-3); }
.layer-arrows { position: absolute; top: 50%; left: 0; right: 0; text-align: center; color: var(--text-3); font-size: 12px; pointer-events: none; }
.value-cards { display: flex; gap: 12px; }
.graph-tip { font-size: 12px; color: var(--text-3); margin-bottom: 6px; }
.mb12 { margin-bottom: 12px; }
.vc { flex: 1; background: #f8fafc; border-radius: 8px; padding: 12px; }
.vc b { display: block; margin-bottom: 4px; }
.vc span { font-size: 12px; color: var(--text-2); }
</style>

<template>
  <div ref="el" :style="{ height: height, width: width || '100%' }" />
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch } from 'vue';
import * as echarts from 'echarts';

const props = defineProps({
  nodes: { type: Array, default: () => [] },
  edges: { type: Array, default: () => [] },
  categories: { type: Array, default: () => [] },
  layout: { type: String, default: 'force' },
  height: { type: String, default: '480px' },
  width: { type: String, default: '' },
  tooltipFormatter: { type: Function, default: null },
});
const emit = defineEmits(['node-click']);
const el = ref(null);
let chart = null;
let ro = null;

function render() {
  if (!chart || !el.value) return;
  chart.resize();
  chart.setOption({
    tooltip: { formatter: props.tooltipFormatter || undefined },
    legend: props.categories.length ? { data: props.categories.map(c => c.name), bottom: 0 } : undefined,
    animationDuration: 400,
    series: [{
      type: 'graph', layout: props.layout, roam: true, scaleLimit: { min: 0.3, max: 3 },
      categories: props.categories,
      data: props.nodes, links: props.edges,
      edgeSymbol: ['none', 'arrow'], edgeSymbolSize: 7,
      label: { show: true, position: 'right', fontSize: 11, color: '#1a2332' },
      emphasis: { focus: 'adjacency', lineStyle: { width: 3 } },
      force: props.layout === 'force' ? { repulsion: 220, edgeLength: [60, 140], gravity: 0.08 } : undefined,
    }],
  }, true);
}
onMounted(() => {
  chart = echarts.init(el.value);
  chart.on('click', (p) => { if (p.dataType === 'node') emit('node-click', p.data); });
  ro = new ResizeObserver(() => chart && chart.resize());
  ro.observe(el.value);
  render();
});
watch(() => [props.nodes, props.edges, props.layout], render, { deep: true });
onUnmounted(() => { ro && ro.disconnect(); chart && chart.dispose(); });
defineExpose({ resize: () => chart && chart.resize() });
</script>

<template>
  <div class="page">
    <el-row :gutter="12">
      <el-col :span="14">
        <el-card shadow="never" class="mb12">
          <template #header>
            <div class="card-header">
              <b>链路节点</b>
              <div>
                <el-button size="small" :disabled="isViewer" @click="impactDlg = true">变更影响评估</el-button>
                <el-button size="small" :disabled="isViewer" @click="autoTicketGen">异常检测转工单</el-button>
              </div>
            </div>
          </template>
          <div style="display:flex;gap:8px" class="mb12">
            <el-select v-model="filterType" size="small" style="width:170px" clearable placeholder="全部类型">
              <el-option v-for="(t, k) in TYPE_NAMES" :key="k" :label="t" :value="k" />
            </el-select>
            <el-select v-model="filterConcept" size="small" style="width:190px" clearable placeholder="全部概念" filterable>
              <el-option v-for="c in concepts" :key="c.code" :label="c.code" :value="c.code" />
            </el-select>
          </div>
          <el-table :data="nodes" size="small" max-height="420" @row-click="openNode">
            <el-table-column label="类型" width="90"><template #default="{ row }"><el-tag size="small" :type="typeTag(row.node_type)">{{ TYPE_NAMES[row.node_type] || row.node_type }}</el-tag></template></el-table-column>
            <el-table-column prop="ref_no" label="单号" width="190" class-name="mono" />
            <el-table-column prop="title" label="标题" min-width="220" show-overflow-tooltip />
            <el-table-column prop="status" label="状态" width="90" />
            <el-table-column prop="occurred_at" label="时间" width="160" />
          </el-table>
        </el-card>
      </el-col>
      <el-col :span="10">
        <el-card shadow="never" class="mb12">
          <template #header>
            <div class="card-header"><b>概念链路视图（故事线）</b></div>
          </template>
          <el-select v-model="chainConcept" filterable size="small" class="mb12" style="width:100%" @change="loadChain">
            <el-option v-for="c in chainConcepts" :key="c" :label="c" :value="c" />
          </el-select>
          <div v-for="(items, type) in chainGroups" :key="type" class="mb12">
            <div style="display:flex;align-items:center;gap:8px">
              <el-tag size="small" :type="typeTag(type)">{{ TYPE_NAMES[type] || type }}</el-tag>
              <el-badge :value="items.length" type="info" />
            </div>
            <el-timeline style="margin-top:8px;padding-left:4px">
              <el-timeline-item v-for="n in items" :key="n.id" :timestamp="n.occurred_at">
                <span style="cursor:pointer" @click="openNode(n)"><b>{{ n.ref_no }}</b> {{ n.title }}（{{ n.status }}）</span>
              </el-timeline-item>
            </el-timeline>
          </div>
          <el-empty v-if="!chainConcept" description="选择概念查看故事线" :image-size="60" />
        </el-card>
      </el-col>
    </el-row>

    <el-drawer v-model="nodeDrawer" size="45%" :title="curNode?.ref_no">
      <template v-if="curNode">
        <el-descriptions :column="1" size="small" border class="mb12">
          <el-descriptions-item label="类型">{{ TYPE_NAMES[curNode.node_type] }}</el-descriptions-item>
          <el-descriptions-item label="标题">{{ curNode.title }}</el-descriptions-item>
          <el-descriptions-item label="概念">{{ curNode.concept_code }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ curNode.status }}</el-descriptions-item>
          <el-descriptions-item label="载荷"><pre class="json-block">{{ pretty(curNode.payload) }}</pre></el-descriptions-item>
        </el-descriptions>
        <div class="mb12"><b>链路追溯（双向 BFS）</b></div>
        <div v-if="trace" class="mb12">
          <div style="font-size:12px;color:var(--text-3)">上游 {{ trace.upstream.length }} 个 / 下游 {{ trace.downstream.length }} 个 / 共 {{ trace.nodes.length }} 节点 {{ trace.edges.length }} 边</div>
          <GraphCanvas :nodes="traceGraphNodes" :edges="traceGraphEdges" layout="force" height="300px" @node-click="(d) => openNodeByRef(d.id)" />
        </div>
        <div class="mb12"><b>直接关联</b></div>
        <el-table :data="curRels" size="small" class="mb12">
          <el-table-column label="关系" min-width="200">
            <template #default="{ row }">{{ row.from_ref_no === curNode.ref_no ? `${row.from_ref_no} → ${row.to_ref_no}` : `${row.to_ref_no} → ${row.from_ref_no}` }}（{{ row.rel_type }}）</template>
          </el-table-column>
          <el-table-column label="" width="70"><template #default="{ row }"><el-button size="small" text type="danger" :disabled="isViewer" @click="delRel(row)">删除</el-button></template></el-table-column>
        </el-table>
        <div class="mb12"><b>添加关联</b></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <el-select v-model="relForm.relType" size="small" style="width:140px">
            <el-option v-for="(t, k) in REL_TYPES" :key="k" :label="t" :value="k" />
          </el-select>
          <el-select v-model="relForm.target" size="small" style="width:220px" filterable placeholder="目标节点">
            <el-option v-for="n in allNodesForRel" :key="n.ref_no" :label="`${n.ref_no} ${n.title}`" :value="n.ref_no" />
          </el-select>
          <el-button size="small" type="primary" :disabled="isViewer" @click="addRel">建立关联</el-button>
        </div>
      </template>
    </el-drawer>

    <el-dialog v-model="impactDlg" title="变更影响评估" width="680px">
      <el-form label-width="90px">
        <el-form-item label="概念"><el-select v-model="impactForm.conceptCode" filterable style="width:100%"><el-option v-for="c in concepts" :key="c.code" :label="c.code" :value="c.code" /></el-select></el-form-item>
        <el-form-item label="影响深度"><el-input-number v-model="impactForm.depth" :min="1" :max="6" /></el-form-item>
        <el-form-item label="变更描述"><el-input v-model="impactForm.changeDesc" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <el-button type="primary" :loading="impacting" @click="doImpact">分析</el-button>
      <div v-if="impact" style="margin-top:12px">
        <el-alert v-if="impact.impactCapped" title="已达最大深度截断" type="warning" class="mb12" :closable="false" />
        <div class="mb12"><b>受影响库表映射</b></div>
        <div v-for="(cols, ds) in impact.affectedTables" :key="ds" class="mb12">
          <el-tag size="small" class="mr4">{{ ds }}</el-tag>
          <span class="mono" style="font-size:12px">{{ cols.join('，') }}</span>
        </div>
        <div class="mb12"><b>上下游分层</b></div>
        <div v-for="(codes, hop) in impact.impactLayers" :key="hop" class="mb12">
          第 {{ hop }} 跳：<el-tag v-for="c in codes" :key="c" size="small" class="mr4">{{ c }}</el-tag>
        </div>
        <el-alert :title="impact.advice" type="info" :closable="false" />
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { listLinks, linkChain, linkTrace, linkChainRels, createLinkRel, deleteLinkRel, autoTicket, analyzeImpact } from '../../api';
import { useUserStore, useConceptStore } from '../../store/user';
import GraphCanvas from '../../components/GraphCanvas.vue';

const userStore = useUserStore();
const conceptStore = useConceptStore();
const isViewer = computed(() => userStore.isViewer);
const concepts = computed(() => conceptStore.concepts);
const TYPE_NAMES = { TICKET: '客服工单', REQUIREMENT: '需求', CHANGE: '研发变更', TESTCASE: '测试用例', DEPLOY: '运维发布', ALERT: '危重预警', DISPOSAL: '处置单' };
const REL_TYPES = { CAUSES: '引发', TRIGGERS: '催生', LEADS_TO: '落地为', COVERED_BY: '被覆盖', SHIPPED_BY: '发布于', CLOSED_BY: '闭环于', RELATES: '通用关联' };
const typeTag = (t) => ({ TICKET: 'danger', REQUIREMENT: 'primary', CHANGE: 'warning', TESTCASE: 'success', DEPLOY: 'info', ALERT: 'danger', DISPOSAL: 'success' }[t] || 'info');
const nodes = ref([]); const filterType = ref(''); const filterConcept = ref('');
const nodeDrawer = ref(false); const curNode = ref(null); const curRels = ref([]); const trace = ref(null);
const chainConcept = ref(''); const chainGroups = ref({}); const chainConcepts = ref([]);
const impactDlg = ref(false); const impactForm = ref({ depth: 3 }); const impact = ref(null); const impacting = ref(false);
const relForm = ref({ relType: 'RELATES' });
const pretty = (s) => { try { return JSON.stringify(JSON.parse(s || '{}'), null, 2); } catch { return s; } };
const allNodesForRel = computed(() => nodes.value.filter(n => n.ref_no !== curNode.value?.ref_no));

const traceGraphNodes = computed(() => (trace.value?.nodes || []).map(n => ({
  id: n.ref_no, name: `${TYPE_NAMES[n.node_type] || n.node_type}\n${n.ref_no}`, symbolSize: n.ref_no === curNode.value?.ref_no ? 40 : 26,
  itemStyle: { color: n.ref_no === curNode.value?.ref_no ? '#2d8a7e' : '#94a3b8' },
})));
const traceGraphEdges = computed(() => (trace.value?.edges || []).map(e => ({ source: e.from_ref_no, target: e.to_ref_no, label: { show: true, formatter: e.rel_type, fontSize: 9 }, lineStyle: { color: '#c0d4e8' } })));

async function loadNodes() { nodes.value = (await listLinks({ nodeType: filterType.value || undefined, conceptCode: filterConcept.value || undefined, pageSize: 100 })).list; }
async function loadChain() {
  if (!chainConcept.value) return;
  const chain = await linkChain(chainConcept.value);
  const groups = {};
  for (const n of chain.nodes) (groups[n.node_type] = groups[n.node_type] || []).push(n);
  const order = ['REQUIREMENT', 'CHANGE', 'TESTCASE', 'DEPLOY', 'ALERT', 'TICKET', 'DISPOSAL'];
  const sorted = {};
  for (const t of order) if (groups[t]) sorted[t] = groups[t];
  chainGroups.value = sorted;
}
async function openNode(row) {
  curNode.value = row;
  nodeDrawer.value = true;
  trace.value = await linkTrace(row.ref_no);
  const chainRels = await linkChainRels(row.concept_code);
  curRels.value = chainRels.filter(r => r.from_ref_no === row.ref_no || r.to_ref_no === row.ref_no);
}
function openNodeByRef(refNo) { const n = trace.value?.nodes.find(x => x.ref_no === refNo); if (n) openNode(n); }
async function addRel() {
  await createLinkRel({ fromRefNo: curNode.value.ref_no, toRefNo: relForm.value.target, relType: relForm.value.relType });
  ElMessage.success('已建立关联'); await openNode(curNode.value);
}
async function delRel(row) { await deleteLinkRel(row.id); await openNode(curNode.value); }
async function autoTicketGen() { const r = await autoTicket(); ElMessage.success(`新建 ${r.created} 张工单`); await loadNodes(); }
async function doImpact() {
  impacting.value = true;
  try { impact.value = await analyzeImpact(impactForm.value); }
  finally { impacting.value = false; }
}
onMounted(async () => {
  await loadNodes();
  if (!conceptStore.loaded) await conceptStore.fetchAll();
  const set = new Set();
  for (const n of nodes.value) set.add(n.concept_code);
  chainConcepts.value = [...set].sort();
  chainConcept.value = chainConcepts.value.includes('DISPENSE') ? 'DISPENSE' : chainConcepts.value[0];
  if (chainConcept.value) loadChain();
});
</script>

<style scoped>
.mb12 { margin-bottom: 12px; } .mr4 { margin-right: 4px; }
:deep(.el-table__row) { cursor: pointer; }
</style>

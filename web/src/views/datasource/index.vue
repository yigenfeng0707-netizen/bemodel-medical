<template>
  <div class="page">
    <el-row :gutter="10" class="mb12">
      <el-col v-for="d in dsList" :key="d.ds_code" :span="6">
        <el-card shadow="hover" :class="{ 'ds-active': curDs === d.ds_code, 'ds-card': true }" @click="selectDs(d.ds_code)">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <b>{{ d.ds_name }}</b> <el-tag size="small" type="info">{{ d.ds_code }}</el-tag>
              <div style="font-size:12px;color:var(--text-3);margin-top:4px">{{ d.product_name }} · {{ d.db_type }}</div>
              <div class="mono" style="font-size:11px;color:var(--text-3)">{{ d.db_name }}</div>
            </div>
            <el-button size="small" :loading="scanning === d.ds_code" :disabled="isViewer" @click.stop="scan(d.ds_code)">扫描</el-button>
          </div>
        </el-card>
      </el-col>
    </el-row>
    <el-row :gutter="12">
      <el-col :span="8">
        <el-card shadow="never">
          <template #header><b>物理表（{{ tables.length }}）</b></template>
          <el-input v-model="tableKw" size="small" placeholder="过滤表名" class="mb12" clearable />
          <div style="max-height:540px;overflow:auto">
            <div v-for="t in filteredTables" :key="t.table_name" class="tbl-row" :class="{ active: curTable === t.table_name }" @click="selectTable(t.table_name)">
              <div><b class="mono">{{ t.table_name }}</b></div>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="16">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <b>映射工作台{{ curTable ? `：${curTable}` : '' }}</b>
              <div>
                <el-tag v-if="aiResult" size="small" :type="aiResult.llmUsed ? 'success' : 'warning'" class="mr4">
                  {{ aiResult.llmUsed ? `AI 推荐（${aiResult.model}）` : '规则降级' }}
                </el-tag>
                <el-button size="small" type="primary" :loading="aiLoading" :disabled="isViewer || !curTable" @click="doAiSuggest">AI 推荐映射</el-button>
                <el-button size="small" :disabled="isViewer || !chosen.size" @click="saveChosen">保存已采纳映射（{{ chosen.size }}）</el-button>
              </div>
            </div>
          </template>
          <el-table v-if="curTable" :data="workbench" size="small" max-height="560">
            <el-table-column label="物理列" min-width="150">
              <template #default="{ row }">
                <span class="mono">{{ row.column_name }}</span>
                <el-tag v-if="row.is_pk" size="small" type="danger" class="mr4">PK</el-tag>
                <div style="font-size:11px;color:var(--text-3)">{{ row.data_type }}</div>
              </template>
            </el-table-column>
            <el-table-column label="当前映射" min-width="240">
              <template #default="{ row }">
                <template v-if="row.mapping">
                  <el-tag size="small" class="mr4" :type="row.mapping.status === 'ACTIVE' ? 'success' : row.mapping.status === 'PROPOSED' ? 'warning' : 'info'">
                    {{ { ACTIVE: '生效中', PROPOSED: '待生效', DEPRECATED: '已停用' }[row.mapping.status] }}
                  </el-tag>
                  <span class="mono">{{ row.mapping.concept_code }}.{{ row.mapping.attr_code }}</span>
                  <el-tooltip v-if="row.mapping.value_map" :content="row.mapping.value_map"><el-tag size="small" type="info" class="mr4">值字典</el-tag></el-tooltip>
                  <el-tag v-if="row.mapping.source === 'AI'" size="small" type="warning">AI</el-tag>
                </template>
                <span v-else style="color:var(--text-3)">未映射</span>
              </template>
            </el-table-column>
            <el-table-column label="AI 建议" min-width="220">
              <template #default="{ row }">
                <template v-if="row.suggestion && row.suggestion.conceptCode">
                  <span class="mono">{{ row.suggestion.conceptCode }}.{{ row.suggestion.attrCode }}</span>
                  <el-tooltip :content="row.suggestion.reason"><el-tag size="small" class="mr4">{{ Math.round(row.suggestion.confidence * 100) }}%</el-tag></el-tooltip>
                  <el-checkbox :model-value="chosen.has(row.column_name)" :disabled="isViewer" @change="toggleChoose(row)">采纳</el-checkbox>
                </template>
                <span v-else-if="row.suggestion" style="color:var(--text-3)">{{ row.suggestion.reason }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button size="small" text :disabled="isViewer" @click="openEdit(row)">编辑映射</el-button>
                <el-button v-if="row.mapping" size="small" text :type="row.mapping.status === 'ACTIVE' ? 'danger' : 'success'" :disabled="isViewer" @click="toggleStatus(row)">
                  {{ row.mapping.status === 'ACTIVE' ? '停用' : '生效' }}
                </el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-else description="选择左侧物理表开始映射" />
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="editDlg" title="编辑映射" width="480px">
      <el-form label-width="80px">
        <el-form-item label="概念"><el-select v-model="editForm.conceptCode" filterable style="width:100%" @change="loadAttrs"><el-option v-for="c in concepts" :key="c.code" :label="`${c.code} ${c.name}`" :value="c.code" /></el-select></el-form-item>
        <el-form-item label="属性"><el-select v-model="editForm.attrCode" style="width:100%"><el-option v-for="a in editAttrs" :key="a.attr_code" :label="`${a.attr_code} ${a.attr_name}`" :value="a.attr_code" /></el-select></el-form-item>
        <el-form-item label="值字典"><el-input v-model="editForm.valueMap" type="textarea" :rows="2" class="mono" placeholder='{"0":"未执行","1":"已执行","2":"已取消"}' /></el-form-item>
      </el-form>
      <template #footer>
        <el-button v-if="editForm.existingId" type="danger" @click="clearMapping">清除映射</el-button>
        <el-button @click="editDlg = false">取消</el-button>
        <el-button type="primary" @click="saveEdit">保存（人工确认）</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { listDatasources, scanDatasource, listTables, listColumns, listMappings, saveMappings, updateMapping, deleteMapping, transitionMapping, aiSuggest, conceptDetail } from '../../api';
import { useConceptStore, useUserStore } from '../../store/user';

const route = useRoute();
const conceptStore = useConceptStore();
const userStore = useUserStore();
const concepts = computed(() => conceptStore.concepts);
const isViewer = computed(() => userStore.isViewer);

const dsList = ref([]);
const curDs = ref('');
const tables = ref([]);
const tableKw = ref('');
const curTable = ref('');
const columns = ref([]);
const mappings = ref([]);
const suggestionsMap = ref({});
const aiResult = ref(null);
const aiLoading = ref(false);
const scanning = ref('');
const chosen = ref(new Set());
const editDlg = ref(false);
const editForm = ref({});
const editAttrs = ref([]);

const filteredTables = computed(() => tables.value.filter(t => !tableKw.value || t.table_name.includes(tableKw.value)));
const workbench = computed(() => columns.value.map(c => ({
  ...c,
  mapping: mappings.value.find(m => m.column_name === c.column_name && m.table_name === curTable.value),
  suggestion: suggestionsMap.value[c.column_name],
})));

async function selectDs(code) {
  curDs.value = code; curTable.value = '';
  tables.value = await listTables(code);
}
function selectTable(t) { curTable.value = t; loadWorkbench(); }
async function loadWorkbench() {
  columns.value = await listColumns(curDs.value, curTable.value);
  mappings.value = await listMappings({ dsCode: curDs.value, tableName: curTable.value });
  chosen.value = new Set();
  if (!conceptStore.loaded) await conceptStore.fetchAll();
}
async function scan(code) {
  scanning.value = code;
  try { const r = await scanDatasource(code); ElMessage.success(`扫描完成：${r.tableCount} 张表`); if (curDs.value === code) tables.value = await listTables(code); }
  finally { scanning.value = ''; }
}
async function doAiSuggest() {
  aiLoading.value = true;
  try {
    aiResult.value = await aiSuggest({ dsCode: curDs.value, tableName: curTable.value });
    suggestionsMap.value = Object.fromEntries(aiResult.value.suggestions.map(s => [s.column, s]));
    if (!aiResult.value.llmUsed) ElMessage.warning(`AI 不可用，已规则降级（失败批次 ${aiResult.value.failedBatches}）`);
  } finally { aiLoading.value = false; }
}
function toggleChoose(row) {
  const s = new Set(chosen.value);
  if (s.has(row.column_name)) s.delete(row.column_name);
  else s.add(row.column_name);
  chosen.value = s;
}
async function saveChosen() {
  const payload = [...chosen.value].map(col => {
    const s = suggestionsMap.value[col];
    return { dsCode: curDs.value, tableName: curTable.value, columnName: col, conceptCode: s.conceptCode, attrCode: s.attrCode, confirmed: 0, source: 'AI' };
  });
  await saveMappings(payload);
  ElMessage.success(`已保存 ${payload.length} 条（AI 建议默认 PROPOSED，待建模员生效）`);
  await loadWorkbench();
}
async function loadAttrs(code) {
  try { editAttrs.value = (await conceptDetail(code)).attributes; } catch { editAttrs.value = []; }
}
function openEdit(row) {
  editForm.value = { conceptCode: row.mapping?.concept_code || '', attrCode: row.mapping?.attr_code || '', valueMap: row.mapping?.value_map || '', existingId: row.mapping?.id, columnName: row.column_name };
  if (editForm.value.conceptCode) loadAttrs(editForm.value.conceptCode);
  editDlg.value = true;
}
async function saveEdit() {
  const f = editForm.value;
  if (f.existingId) {
    await updateMapping(f.existingId, { conceptCode: f.conceptCode, attrCode: f.attrCode, valueMap: f.valueMap || null, confirmed: 1 });
  } else {
    await saveMappings([{ dsCode: curDs.value, tableName: curTable.value, columnName: f.columnName, conceptCode: f.conceptCode, attrCode: f.attrCode, valueMap: f.valueMap || null, confirmed: 1, source: 'MANUAL' }]);
  }
  editDlg.value = false; await loadWorkbench();
}
async function clearMapping() { await deleteMapping(editForm.value.existingId); editDlg.value = false; await loadWorkbench(); }
async function toggleStatus(row) {
  const target = row.mapping.status === 'ACTIVE' ? 'DEPRECATED' : row.mapping.status === 'PROPOSED' ? 'ACTIVE' : 'ACTIVE';
  await transitionMapping(row.mapping.id, target);
  await loadWorkbench();
}
onMounted(async () => {
  dsList.value = await listDatasources();
  if (route.query.ds) selectDs(route.query.ds);
});
watch(() => route.query.ds, (v) => { if (v) selectDs(v); });
</script>

<style scoped>
.ds-card { cursor: pointer; transition: var(--transition); }
.ds-active { border: 1.5px solid var(--primary); }
.tbl-row { padding: 8px 10px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.tbl-row:hover { background: #f3f7f6; }
.tbl-row.active { background: #e6f2f0; color: var(--primary); font-weight: 600; }
.mb12 { margin-bottom: 12px; } .mr4 { margin-right: 4px; }
</style>

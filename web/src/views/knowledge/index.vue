<template>
  <div class="page">
    <el-tabs v-model="tab">
      <el-tab-pane label="制度文档" name="doc">
        <el-card shadow="never">
          <template #header>
            <div class="card-header"><b>制度文档（摄取 → 切分 → 向量化 → 混合检索）</b>
              <el-button type="primary" size="small" :disabled="isViewer" @click="uploadDlg = true">上传文档</el-button>
            </div>
          </template>
          <el-table :data="docs" size="small">
            <el-table-column prop="title" label="标题" min-width="200" />
            <el-table-column prop="doc_type" label="类型" width="80" />
            <el-table-column label="状态" width="100">
              <template #default="{ row }"><el-tag size="small" :type="docTag(row.status)">{{ docText(row.status) }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="version" label="版本" width="70" />
            <el-table-column prop="chunk_count" label="片段" width="70" />
            <el-table-column prop="owner" label="负责人" width="110" />
            <el-table-column label="操作" width="240">
              <template #default="{ row }">
                <el-button size="small" text @click="previewChunks(row)">片段</el-button>
                <el-button v-if="row.status === 'DRAFT'" size="small" text type="primary" :disabled="isViewer" @click="trDoc(row, 'REVIEW')">提交评审</el-button>
                <el-button v-if="row.status === 'REVIEW'" size="small" text type="success" :disabled="!canReview" @click="trDoc(row, 'PUBLISHED')">发布</el-button>
                <el-button v-if="row.status === 'PUBLISHED'" size="small" text type="danger" :disabled="!canReview" @click="trDoc(row, 'DEPRECATED')">停用</el-button>
                <el-button v-if="row.status === 'DEPRECATED'" size="small" text :disabled="isViewer" @click="trDoc(row, 'DRAFT')">恢复</el-button>
                <el-button v-if="row.status !== 'PUBLISHED'" size="small" text type="danger" :disabled="isViewer" @click="delDoc(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>
      <el-tab-pane label="知识条目" name="entry">
        <el-card shadow="never">
          <template #header>
            <div class="card-header"><b>结构化经验条目（核对归因 / 客服规则 / 整改依据）</b>
              <el-button type="primary" size="small" :disabled="isViewer" @click="entryDlg = true">新增条目</el-button>
            </div>
          </template>
          <el-table :data="entries" size="small">
            <el-table-column prop="code" label="编码" width="260" class-name="mono" />
            <el-table-column prop="title" label="标题" min-width="160" />
            <el-table-column prop="applies_to" label="适用场景" width="180" />
            <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag size="small" :type="docTag(row.status)">{{ docText(row.status) }}</el-tag></template></el-table-column>
            <el-table-column prop="version" label="版本" width="70" />
            <el-table-column prop="owner" label="负责人" width="110" />
            <el-table-column label="操作" width="200">
              <template #default="{ row }">
                <el-button size="small" text :disabled="isViewer" @click="editEntry(row)">编辑</el-button>
                <el-button v-if="row.status === 'DRAFT' || row.status === 'REVIEW'" size="small" text type="success" :disabled="!canReview" @click="trEntry(row, 'PUBLISHED')">发布</el-button>
                <el-button v-if="row.status === 'PUBLISHED'" size="small" text type="danger" :disabled="!canReview" @click="trEntry(row, 'DEPRECATED')">停用</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="uploadDlg" title="上传文档（.md / .pdf / .docx / .txt）" width="520px">
      <el-upload drag :auto-upload="false" :limit="1" :on-change="(f) => uploadFile = f.raw">
        <el-icon style="font-size:32px"><UploadFilled /></el-icon>
        <div>拖拽文件或点击选择</div>
      </el-upload>
      <el-input v-model="uploadOwner" placeholder="负责人" style="margin-top:10px" />
      <template #footer>
        <el-button @click="uploadDlg = false">取消</el-button>
        <el-button type="primary" :loading="uploading" :disabled="!uploadFile" @click="doUpload">上传并解析</el-button>
      </template>
    </el-dialog>
    <el-dialog v-model="chunkDlg" title="片段预览" width="720px">
      <el-table :data="chunks" size="small" max-height="480">
        <el-table-column prop="seq" label="#" width="50" />
        <el-table-column prop="heading" label="章节" width="140" />
        <el-table-column prop="content" label="内容" show-overflow-tooltip />
        <el-table-column label="向量" width="90"><template #default="{ row }"><el-tag size="small" :type="row.has_embedding ? 'success' : 'info'">{{ row.has_embedding ? '已向量化' : '未向量化' }}</el-tag></template></el-table-column>
      </el-table>
    </el-dialog>
    <el-dialog v-model="entryEditDlg" title="编辑条目" width="600px">
      <el-alert v-if="entryForm.status === 'PUBLISHED'" title="已发布条目再次保存会自动进入待审核（改一条走审批）" type="warning" class="mb12" :closable="false" />
      <el-form label-width="80px">
        <el-form-item label="编码"><el-input :model-value="entryForm.code" disabled class="mono" /></el-form-item>
        <el-form-item label="标题"><el-input v-model="entryForm.title" /></el-form-item>
        <el-form-item label="内容"><el-input v-model="entryForm.content" type="textarea" :rows="5" /></el-form-item>
        <el-form-item label="适用场景"><el-input v-model="entryForm.appliesTo" placeholder="逗号分隔概念码，如 FEE_DETAIL,DISPENSE" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="entryEditDlg = false">取消</el-button><el-button type="primary" @click="saveEntry">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { UploadFilled } from '@element-plus/icons-vue';
import { listDocuments, uploadDocument, listChunks, transitionDocument, deleteDocument, listEntries, createEntry, updateEntry, transitionEntry } from '../../api';
import { useUserStore } from '../../store/user';

const userStore = useUserStore();
const isViewer = computed(() => userStore.isViewer);
const canReview = computed(() => userStore.canReview);
const tab = ref('doc');
const docs = ref([]); const entries = ref([]);
const uploadDlg = ref(false); const uploadFile = ref(null); const uploadOwner = ref(''); const uploading = ref(false);
const chunkDlg = ref(false); const chunks = ref([]);
const entryDlg = ref(false); const entryEditDlg = ref(false); const entryForm = ref({});
const docText = (s) => ({ DRAFT: '草稿', REVIEW: '待审核', PUBLISHED: '已发布', DEPRECATED: '已停用' }[s] || s);
const docTag = (s) => ({ DRAFT: 'info', REVIEW: 'warning', PUBLISHED: 'success', DEPRECATED: 'danger' }[s] || 'info');
async function loadDocs() { docs.value = await listDocuments(); }
async function loadEntries() { entries.value = await listEntries(); }
async function doUpload() {
  uploading.value = true;
  try {
    const fd = new FormData();
    fd.append('file', uploadFile.value);
    fd.append('owner', uploadOwner.value);
    const r = await uploadDocument(fd);
    ElMessage.success(`上传并解析完成（${r.chunks} 个片段，待审核）`);
    uploadDlg.value = false; await loadDocs();
  } finally { uploading.value = false; }
}
async function previewChunks(row) { chunks.value = await listChunks(row.id); chunkDlg.value = true; }
async function trDoc(row, target) { await transitionDocument(row.id, target); await loadDocs(); }
async function delDoc(row) { await ElMessageBox.confirm('确认删除？'); await deleteDocument(row.id); await loadDocs(); }
function editEntry(row) { entryForm.value = { ...row, appliesTo: row.applies_to }; entryEditDlg.value = true; }
async function saveEntry() {
  if (entryForm.value.id) await updateEntry(entryForm.value.id, entryForm.value);
  else await createEntry(entryForm.value);
  entryEditDlg.value = false; entryDlg.value = false; await loadEntries();
}
async function trEntry(row, target) { await transitionEntry(row.id, target); await loadEntries(); }
onMounted(() => { loadDocs(); loadEntries(); });
</script>

<style scoped>
.mb12 { margin-bottom: 12px; }
</style>

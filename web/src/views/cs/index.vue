<template>
  <div class="page">
    <el-card shadow="never" class="mb12">
      <b>问一问</b>
      <div style="display:flex;gap:8px;margin-top:8px">
        <el-input v-model="question" placeholder="例如：检验取消了怎么还收费？" @keyup.enter="ask('CS')">
          <template #append><el-button :loading="asking" @click="ask('CS')">提问</el-button></template>
        </el-input>
      </div>
      <div style="margin-top:8px">
        <el-link v-for="q in quickQs" :key="q" class="mr8" type="primary" @click="question = q; ask('CS')">{{ q }}</el-link>
      </div>
      <div v-if="lastAnswer" class="answer-card">
        <div style="display:flex;gap:6px;align-items:center">
          <el-tag size="small">{{ lastAnswer.intent || '未命中' }}</el-tag>
          <el-tag size="small" :type="routerTag(lastAnswer.router)">{{ routerText(lastAnswer.router) }}</el-tag>
          <el-tag v-if="lastAnswer.ruleFallback" size="small" type="warning">规则兜底</el-tag>
        </div>
        <div class="answer-text">{{ lastAnswer.answer }}</div>
        <div v-for="(e, i) in lastAnswer.evidence || []" :key="i" class="evidence-line">
          <b>{{ e[0] }}：</b>{{ e[1] }}
        </div>
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
          <el-button v-for="l in lastAnswer.links || []" :key="l.route" size="small" @click="$router.push(l.route)">{{ l.label }}</el-button>
          <el-button size="small" type="success" plain @click="feedback(true)">👍 有用</el-button>
          <el-button size="small" type="danger" plain @click="feedback(false)">👎 归类不对</el-button>
        </div>
        <div v-if="lastAnswer.reconRunId" style="margin-top:8px">
          <el-button size="small" @click="openRecon(lastAnswer.reconRunId)">查看跨库核对差异登记</el-button>
        </div>
      </div>
    </el-card>

    <el-row :gutter="12">
      <el-col :span="7">
        <el-card shadow="never">
          <template #header>
            <div class="card-header"><b>客服工单</b><el-button size="small" @click="autoTicketGen">异常检测转工单</el-button></div>
          </template>
          <div style="max-height:640px;overflow:auto">
            <div v-for="t in tickets" :key="t.id" class="ticket-row" :class="{ active: curTicket?.id === t.id }" @click="selectTicket(t)">
              <div style="display:flex;justify-content:space-between">
                <b style="font-size:13px">{{ t.title }}</b>
                <el-tag size="small" :type="{ 待处理: 'danger', 处理中: 'warning', 已处置: 'info' }[t.status] || 'info'">{{ t.status }}</el-tag>
              </div>
              <div style="font-size:11px;color:var(--text-3);margin-top:4px">{{ t.ref_no }} · {{ t.occurred_at }}</div>
            </div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="17">
        <el-card shadow="never" v-if="curTicket">
          <template #header><b>工单详情与 AI 诊断</b></template>
          <el-descriptions :column="2" size="small" border class="mb12">
            <el-descriptions-item label="单号">{{ curTicket.ref_no }}</el-descriptions-item>
            <el-descriptions-item label="状态">{{ curTicket.status }}</el-descriptions-item>
            <el-descriptions-item label="标题" :span="2">{{ curTicket.title }}</el-descriptions-item>
            <el-descriptions-item v-for="(v, k) in ticketPayload" :key="k" :label="k">{{ v }}</el-descriptions-item>
          </el-descriptions>
          <el-button size="small" type="primary" :loading="diagnosing" @click="diagnose">AI 智能诊断（RCA 七步探针）</el-button>
          <el-button v-if="curTicket.status === '待处理'" size="small" type="success" @click="refund">一键处置（生成退费申请）</el-button>
          <el-button size="small" @click="loadReply">给客户的回复</el-button>

          <template v-if="diagnosis">
            <el-alert :title="diagnosis.conclusion" type="success" class="mb12" style="margin-top:12px" :closable="false" />
            <div class="mb12"><b>排查过程</b></div>
            <el-steps direction="vertical" :active="diagnosis.steps.length">
              <el-step v-for="s in diagnosis.steps" :key="s.stepNo" :title="s.stepName" :description="`${stepTypeText(s.stepType)} · 命中 ${s.hitCount}`">
                <template #description>
                  <div>{{ stepTypeText(s.stepType) }} · 命中 {{ s.hitCount }}</div>
                  <el-collapse v-if="s.sqlText || s.result">
                    <el-collapse-item title="查看查询结果明细">
                      <pre v-if="s.sqlText" class="sql-block">{{ s.sqlText }}</pre>
                      <pre class="json-block">{{ pretty(s.result) }}</pre>
                    </el-collapse-item>
                  </el-collapse>
                </template>
              </el-step>
            </el-steps>
            <div class="mb12" style="margin-top:12px"><b>处置建议</b></div>
            <ol style="font-size:13px;line-height:2">
              <li v-for="(s, i) in diagnosis.suggestions" :key="i">{{ s }}</li>
            </ol>
          </template>
          <div v-if="reply" class="answer-card" style="margin-top:12px">
            <b>客户回复：</b>{{ reply }}
          </div>
        </el-card>
        <el-card v-else shadow="never"><el-empty description="选择左侧工单查看 AI 诊断" /></el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="reconDlg" title="跨库核对差异登记（六语义档）" width="880px">
      <el-table :data="reconDiffs" size="small" max-height="480">
        <el-table-column prop="direction" label="向" width="60" />
        <el-table-column label="语义档" min-width="200">
          <template #default="{ row }">
            <el-tag size="small" :type="{ VIOLATION: 'danger', WATCH: 'warning', NORMAL: 'info' }[row.severity]" class="mr4">{{ row.severity }}</el-tag>
            {{ row.state_code }}
          </template>
        </el-table-column>
        <el-table-column prop="patient_no" label="患者/单据" width="130" />
        <el-table-column prop="order_id" label="医嘱" width="150" />
        <el-table-column prop="item_name" label="项目" width="130" />
        <el-table-column prop="attribution" label="归因" show-overflow-tooltip />
        <el-table-column prop="suggested_action" label="建议动作" show-overflow-tooltip />
      </el-table>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  listTickets, ticketDiagnosis, refundTicket, ticketReply, askCs, listReconDiffs, submitCsFeedback, autoTicket, listClarify,
} from '../../api';

const route = useRoute();
const question = ref('');
const asking = ref(false);
const lastAnswer = ref(null);
const quickQs = ['检验取消了怎么还收费？', '已缴费未发药正常吗？', '一条医嘱可以分两次发药吗？', '取消未退费笔数这个口径怎么算？', '低库存的药有哪些？'];
const tickets = ref([]); const curTicket = ref(null); const diagnosis = ref(null); const diagnosing = ref(false);
const reply = ref(''); const reconDlg = ref(false); const reconDiffs = ref([]);
const ticketPayload = computed(() => { try { return JSON.parse(curTicket.value?.payload || '{}'); } catch { return {}; } });
const pretty = (o) => { try { return JSON.stringify(typeof o === 'string' ? JSON.parse(o) : o, null, 2); } catch { return String(o); } };
const stepTypeText = (t) => ({ TRAVERSE: '沿本体关系找数据', PROBE: '跨库真实查询', LINK: '翻变更留痕', REPORT: '产出结论' }[t] || t);
const routerText = (r) => ({ LLM: 'AI 归类', RULE: '规则路由', SEMANTIC: '语义查询', REFERRAL: '场景转介', NONE: '未命中' }[r] || r);
const routerTag = (r) => ({ LLM: 'success', RULE: '', SEMANTIC: 'warning', REFERRAL: 'info', NONE: 'danger' }[r] || 'info');

async function ask(scene) {
  if (!question.value) return;
  asking.value = true;
  try {
    lastAnswer.value = await askCs(question.value, scene);
  } catch (e) {
    const slow = e?.code === 'ECONNABORTED' || /timeout/i.test(e?.message || '');
    lastAnswer.value = { answer: slow ? '本次语义解析耗时较长，已超过等待上限，请换个更简短的问法重试。' : (e?.message || '请求失败，请重试。'), router: 'NONE' };
  } finally { asking.value = false; }
}
async function loadTickets() { tickets.value = (await listTickets({ pageSize: 50 })).list; }
async function selectTicket(t) {
  curTicket.value = t; diagnosis.value = null; reply.value = '';
  diagnosing.value = true;
  try { diagnosis.value = await ticketDiagnosis(t.id); }
  catch { /* */ }
  finally { diagnosing.value = false; }
}
async function diagnose() {
  diagnosing.value = true;
  try { diagnosis.value = await ticketDiagnosis(curTicket.value.id); }
  catch { /* */ }
  finally { diagnosing.value = false; }
}
async function refund() {
  await ElMessageBox.confirm('生成退费申请并办结工单？', '一键处置');
  const r = await refundTicket(curTicket.value.id);
  ElMessage.success(`已生成 ${r.refundCount} 笔退费申请，合计 ¥${r.totalAmount}，处置单 ${r.disposalRef}`);
  await loadTickets(); curTicket.value = tickets.value.find(t => t.id === curTicket.value.id) || null;
}
async function loadReply() {
  const r = await ticketReply(curTicket.value.id);
  reply.value = r.reply + (r.basis?.length ? `（依据条目：${r.basis.join('、')}）` : '');
}
async function openRecon(runId) { reconDiffs.value = await listReconDiffs(runId); reconDlg.value = true; }
async function feedback(correct) {
  if (correct) { ElMessage.success('感谢反馈'); return; }
  const { value } = await ElMessageBox.prompt('正确的意图或说明', '归类不对');
  await submitCsFeedback({ question: question.value, intent: lastAnswer.value?.intent, router: lastAnswer.value?.router, correct: false, comment: value });
  ElMessage.success('已回流路由提示词（错例反馈回路）');
}
async function autoTicketGen() { const r = await autoTicket(); ElMessage.success(`扫描完成，新建 ${r.created} 张工单`); await loadTickets(); }

onMounted(async () => {
  await loadTickets();
  if (tickets.value.length) selectTicket(tickets.value[0]);
  if (route.query.q) { question.value = route.query.q; ask('CS'); }
  if (route.query.recon) openRecon(route.query.recon);
  if (route.query.ticketId) {
    const all = await listTickets({ pageSize: 200 });
    const t = all.list.find(x => String(x.id) === route.query.ticketId);
    if (t) selectTicket(t);
  }
});
</script>

<style scoped>
.answer-card { margin-top: 12px; background: #f0faf7; border-radius: 10px; padding: 12px 14px; }
.answer-text { margin: 8px 0; line-height: 1.8; }
.evidence-line { font-size: 12px; color: var(--text-2); }
.ticket-row { padding: 10px; border: 1px solid #eef2f5; border-radius: 8px; margin-bottom: 8px; cursor: pointer; }
.ticket-row:hover { border-color: var(--primary); }
.ticket-row.active { border-color: var(--primary); background: #f0faf7; }
.mb12 { margin-bottom: 12px; } .mr8 { margin-right: 8px; } .mr4 { margin-right: 4px; }
</style>

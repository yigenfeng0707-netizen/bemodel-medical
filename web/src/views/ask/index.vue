<template>
  <div class="ask-page">
    <div class="chat-col">
      <div class="chat-scroll">
        <div v-if="!msgs.length" class="welcome">
          <div class="welcome-icon">Bm</div>
          <h2>智能问数</h2>
          <p>LLM 只负责表达语义计划，SQL 经白名单校验后在真实业务库执行；答不了的问题诚实回流，绝不编数。</p>
          <div class="chips">
            <el-tag v-for="q in suggestions" :key="q" class="chip" @click="send(q)">{{ q }}</el-tag>
          </div>
        </div>
        <div v-for="(m, i) in msgs" :key="i" :class="['msg', m.role]">
          <div v-if="m.role === 'user'" class="bubble user-bubble">{{ m.text }}</div>
          <div v-else class="bubble ai-bubble">
            <div class="ai-head">
              <span class="bm-avatar">Bm</span>
              <el-tag v-if="m.router" size="small" :type="routerTag(m.router)">{{ routerText(m.router) }}</el-tag>
              <el-tag v-if="m.ruleFallback" size="small" type="warning">规则兜底</el-tag>
              <el-link v-if="m.traceId" type="primary" :underline="false" @click="$router.push(`/trace?type=QA&key=${m.traceId}`)">证据链 {{ m.traceId }}</el-link>
            </div>

            <div class="answer">{{ m.text }}</div>

            <div v-if="m.metricCards?.length" class="metric-cards">
              <div v-for="c in m.metricCards" :key="c.metricCode" class="mc">
                <div style="display:flex;justify-content:space-between">
                  <b>{{ c.name }}</b>
                  <el-tag v-if="c.lastVal != null && c.warnThreshold != null && c.lastVal > c.warnThreshold" size="small" type="danger">超阈值</el-tag>
                </div>
                <div class="mc-val">{{ c.lastVal ?? c.error }}</div>
                <div class="mc-def">{{ c.definition }}</div>
                <pre class="sql-block" style="max-height:70px">{{ c.probeSql }}</pre>
                <div v-if="c.reconciled" style="font-size:12px;color:var(--warning)">对账组 {{ c.reconciled.group_code }}：{{ { OPEN: '存在未裁决差额', CLAIMED: '对账中', RESOLVED: '已裁决' }[c.reconciled.dispute_status] }}</div>
              </div>
            </div>

            <div v-if="m.parse" class="parse-panel">
              <div class="pp-title">语义解析</div>
              <div class="pp-row"><b>命中概念：</b>
                <el-tag v-for="c in m.parse.matchedConcepts" :key="c" size="small" class="mr4" @click="$router.push(`/ontology?concept=${c}`)">{{ c }}</el-tag>
                <span v-if="!m.parse.matchedConcepts?.length" style="color:var(--text-3)">无</span>
              </div>
              <div class="pp-row"><b>查询逻辑：</b>{{ m.parse.semantics }}</div>
              <el-collapse>
                <el-collapse-item title="执行 SQL（白名单校验后真实执行）">
                  <pre class="sql-block">{{ m.parse.sql }}</pre>
                  <el-table v-if="m.parse.rows?.length" :data="m.parse.rows" size="small" max-height="240">
                    <el-table-column v-for="k in Object.keys(m.parse.rows[0] || {})" :key="k" :prop="k" :label="k" min-width="110" />
                  </el-table>
                  <div style="font-size:12px;color:var(--text-3)">返回 {{ m.parse.rowCount }} 行（已脱敏，最多展示 20 行）</div>
                </el-collapse-item>
              </el-collapse>
            </div>

            <div v-if="m.clarify" class="clarify-card">
              <b>需要澄清：</b>{{ m.clarify.clarifyQuestion }}
              <div style="display:flex;gap:8px;margin-top:8px">
                <el-input v-model="m.clarifyInput" size="small" placeholder="补充时间/科室/对象/口径" />
                <el-button size="small" type="primary" :loading="m.loading" @click="submitClarify(m, i)">提交补充</el-button>
              </div>
              <div v-if="m.clarifyRetry" style="font-size:12px;color:var(--warning);margin-top:4px">根据补充仍未命中（第 {{ m.clarify.rounds }} 轮）</div>
            </div>
            <div v-if="m.unanswered" class="unanswered">
              <el-alert :title="m.text" type="warning" :closable="false" />
              <el-button size="small" style="margin-top:8px" @click="$router.push('/evolve')">查看概念缺口</el-button>
            </div>
          </div>
        </div>
        <div v-if="thinking" class="thinking">正在解析语义并生成查询计划<span class="dots"><i></i><i></i><i></i></span></div>
      </div>
      <div class="input-bar">
        <el-input v-model="input" type="textarea" :rows="2" placeholder="问点数据的事…（Enter 发送，Shift+Enter 换行）" @keydown.enter.exact.prevent="send()" />
        <el-button type="primary" :loading="thinking" @click="send()">发送</el-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { askCs, answerClarify } from '../../api';

const route = useRoute();
const input = ref('');
const msgs = ref([]);
const thinking = ref(false);
const suggestions = ['出院多少人？', '9月住院总费用是多少？', '出院人数怎么算？', '结算单有多少笔？', '低库存的药有哪些？'];
const routerText = (r) => ({ LLM: 'AI 归类', RULE: '规则路由', SEMANTIC: '语义查询', REFERRAL: '场景转介' }[r] || r);
const routerTag = (r) => ({ LLM: 'success', RULE: '', SEMANTIC: 'warning', REFERRAL: 'info' }[r] || 'info');

async function send(q) {
  const text = (q || input.value || '').trim();
  if (!text || thinking.value) return;
  msgs.value.push({ role: 'user', text });
  input.value = '';
  thinking.value = true;
  try {
    const r = await askCs(text, 'ANALYTICS');
    msgs.value.push({
      role: 'ai', text: r.answer || '', router: r.router, intent: r.intent, mode: r.mode,
      parse: r.parse, metricCards: r.metricCards, traceId: r.traceId, ruleFallback: r.ruleFallback,
      clarify: r.clarify ? { ...r.clarify, clarifyInput: '' } : null, unanswered: r.unanswered,
      links: r.links,
    });
  } catch (e) {
    const slow = e?.code === 'ECONNABORTED' || /timeout/i.test(e?.message || '');
    msgs.value.push({ role: 'ai', text: slow ? '本次语义解析耗时较长，已超过等待上限。可换个更简短的问法重试，或稍后再试。' : (e?.message || '请求失败，请重试。'), unanswered: true });
  } finally { thinking.value = false; }
}
async function submitClarify(m, idx) {
  if (!m.clarifyInput?.trim()) return;
  m.loading = true;
  try {
    const r = await answerClarify(m.clarify.id, m.clarifyInput.trim());
    if (r.clarifyResolved) {
      msgs.value.push({ role: 'ai', text: '根据你的补充已答出：' + (r.answer || ''), router: r.router, parse: r.parse, metricCards: r.metricCards, traceId: r.traceId });
      m.clarify = null;
    } else if (r.gaveUp) {
      m.clarify = null;
      msgs.value.push({ role: 'ai', text: r.answer, unanswered: true, router: r.router });
    } else if (r.clarify) {
      m.clarify = { ...r.clarify, clarifyInput: '' };
      m.clarifyRetry = true;
    } else {
      msgs.value.push({ role: 'ai', text: r.answer || '已更新', parse: r.parse, metricCards: r.metricCards, traceId: r.traceId });
      m.clarify = null;
    }
  } finally { m.loading = false; }
}
onMounted(() => { if (route.query.q) send(route.query.q); });
</script>

<style scoped>
.ask-page { height: calc(100vh - var(--topbar-height) - 40px); display: flex; }
.chat-col { flex: 1; display: flex; flex-direction: column; background: #fff; border-radius: 12px; overflow: hidden; }
.chat-scroll { flex: 1; overflow-y: auto; padding: 20px; }
.welcome { text-align: center; padding: 60px 0; }
.welcome-icon { width: 52px; height: 52px; border-radius: 14px; background: linear-gradient(135deg, var(--primary), var(--primary-light)); color: #fff; font-weight: 700; font-size: 20px; display: inline-flex; align-items: center; justify-content: center; }
.welcome p { color: var(--text-3); font-size: 13px; }
.chips { margin-top: 16px; display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
.chip { cursor: pointer; }
.msg { display: flex; margin-bottom: 16px; }
.msg.user { justify-content: flex-end; }
.bubble { max-width: 82%; border-radius: 12px; padding: 10px 14px; }
.user-bubble { background: var(--primary); color: #fff; }
.ai-bubble { background: #f7faf9; border: 1px solid #e8f0ee; }
.ai-head { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.bm-avatar { width: 26px; height: 26px; border-radius: 50%; background: linear-gradient(135deg, var(--primary), var(--primary-light)); color: #fff; font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.answer { line-height: 1.8; font-size: 14px; }
.metric-cards { display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
.mc { border: 1px solid #eef2f5; border-radius: 10px; padding: 10px 12px; min-width: 240px; background: #fff; }
.mc-val { font-size: 26px; font-weight: 700; color: var(--primary); margin: 4px 0; }
.mc-def { font-size: 12px; color: var(--text-2); margin-bottom: 6px; }
.parse-panel { margin-top: 10px; background: #fff; border: 1px dashed #d8e5e2; border-radius: 10px; padding: 10px 12px; }
.pp-title { font-weight: 600; margin-bottom: 6px; }
.pp-row { font-size: 13px; margin-bottom: 6px; }
.clarify-card { margin-top: 10px; background: #fffaf0; border: 1px solid #f5e0b8; border-radius: 10px; padding: 10px 12px; }
.unanswered { margin-top: 10px; }
.thinking { padding: 12px 24px; color: var(--text-3); font-size: 13px; }
.dots i { display: inline-block; width: 4px; height: 4px; border-radius: 50%; background: var(--text-3); margin-left: 3px; animation: blink 1.2s infinite; }
.dots i:nth-child(2) { animation-delay: .2s; } .dots i:nth-child(3) { animation-delay: .4s; }
@keyframes blink { 0%, 80%, 100% { opacity: .2; } 40% { opacity: 1; } }
.input-bar { display: flex; gap: 10px; padding: 12px 20px; border-top: 1px solid #eef2f5; align-items: flex-end; }
.mb12 { margin-bottom: 12px; } .mr4 { margin-right: 4px; }
</style>

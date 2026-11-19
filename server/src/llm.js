import express from 'express';
import { platform, now } from './db.js';
import { config } from './config.js';
import { ok } from './common.js';

// ---------- 熔断（纯内存、每端点一实例、重启复位） ----------
class CircuitState {
  constructor() { this.failures = 0; this.openedAt = 0; }
  recordSuccess() { this.failures = 0; this.openedAt = 0; }
  recordFailure() {
    this.failures += 1;
    if (this.failures >= config.llm.failureThreshold) this.openedAt = Date.now();
  }
  isUsable() {
    if (!this.openedAt) return true;
    if (Date.now() - this.openedAt >= config.llm.cooldownMs) return true; // 冷却过即放行（惰性半开）
    return false;
  }
  get open() { return !!this.openedAt && Date.now() - this.openedAt < config.llm.cooldownMs; }
}
const circuits = { primary: new CircuitState(), backup: new CircuitState() };

function endpoints() {
  const p = config.llm.primary, b = config.llm.backup;
  return [
    { name: 'primary', baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model },
    b.apiKey ? { name: 'backup', baseUrl: b.baseUrl || p.baseUrl, apiKey: b.apiKey, model: b.model || p.model } : null,
  ].filter(Boolean);
}
export function llmEnabled() { return endpoints().some(e => e.apiKey); }

export async function currentTag() {
  const r = await platform.prepare('SELECT version_tag FROM bm_release ORDER BY id DESC LIMIT 1').get();
  return r ? r.version_tag : '未发布';
}

async function logLlm(callType, provider, model, prompts, latencyMs, success, errMsg) {
  try {
    await platform.prepare(`INSERT INTO bm_llm_log(call_type, provider, model, ontology_version, prompt_digest, latency_ms, success, err_msg, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      callType, provider, model, await currentTag(),
      (prompts.system + ' | ' + prompts.user).slice(0, 200), latencyMs, success ? 1 : 0, errMsg || null, now());
  } catch { /* 审计失败不影响主流程 */ }
}

async function attempt(ep, systemPrompt, userPrompt, timeoutMs, maxTokens) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(ep.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}` },
      body: JSON.stringify({
        model: ep.model, temperature: 0.2, max_tokens: maxTokens,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      }),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    const body = JSON.parse(text);
    const choice = body.choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error('输出被截断（finish_reason=length）');
    const content = choice?.message?.content;
    if (!content) throw new Error('响应缺 content 字段');
    return content;
  } finally { clearTimeout(timer); }
}

/**
 * LLM 网关：主备路由 + 熔断 + 按 callType 超时/限额 + 审计。
 * 返回文本或 null（调用方必须自带规则/模板降级，绝不 500）。
 */
export async function chat(callType, systemPrompt, userPrompt) {
  const eps = endpoints();
  if (!eps.length || !eps[0].apiKey) return null; // 无 Key：环境问题，不落审计，直接降级
  const timeoutMs = config.llm.callTimeouts[callType] || config.llm.timeoutSeconds * 1000;
  const maxTokens = config.llm.callMaxTokens[callType] || config.llm.maxTokens;
  const ordered = [...eps]; // 复现版简化：主路优先，备路兜底
  for (const ep of ordered) {
    const c = circuits[ep.name];
    if (!c.isUsable()) continue;
    // 429/限流：预算内退避重试一次（免费 token 档 RPM/TPM 很紧）
    for (let attemptNo = 0; attemptNo < 2; attemptNo++) {
      const started = Date.now();
      try {
        const content = await attempt(ep, systemPrompt, userPrompt, Math.max(8000, timeoutMs - (Date.now() - started)), maxTokens);
        c.recordSuccess();
        await logLlm(callType, ep.name, ep.model, { system: systemPrompt, user: userPrompt }, Date.now() - started, true, null);
        return content;
      } catch (e) {
        c.recordFailure();
        const msg = String(e.message || e || e.name || 'unknown').slice(0, 500);
        await logLlm(callType, ep.name, ep.model, { system: systemPrompt, user: userPrompt }, Date.now() - started, false, msg);
        const rateLimited = /429|rate|quota|exhausted|tpm|rpm/i.test(msg);
        if (rateLimited && attemptNo === 0 && Date.now() - started < timeoutMs) {
          await new Promise(s => setTimeout(s, 20000));
          continue;
        }
        break;
      }
    }
  }
  return null;
}

/** JSON 解析容错：平衡括号扫描（感知字符串/转义），截取首个完整 {...} 或 [...]；
 *  旧实现 lastIndexOf('}') 会把 JSON 后面的乱码尾巴一并截入导致解析失败。解析失败返回 null */
export function parseJsonLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fallthrough */ }
  const scanBalanced = (i) => {
    const open = text[i];
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let k = i; k < text.length; k++) {
      const ch = text[k];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) { depth--; if (depth === 0) return text.slice(i, k + 1); }
    }
    return null;
  };
  for (const open of '{[') {
    const i = text.indexOf(open);
    if (i < 0) continue;
    const slice = scanBalanced(i);
    if (slice) {
      try { return JSON.parse(slice); } catch { /* try next */ }
    }
  }
  return null;
}

// ---------- 审计查询端点 ----------
export const llmRouter = express.Router();
llmRouter.get('/log/list', async (req, res) => {
  const pageNum = Math.max(1, parseInt(req.query.pageNum || '1', 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize || '20', 10)));
  const total = await platform.prepare('SELECT COUNT(*) c FROM bm_llm_log').get();
  const c = total?.c ?? 0;
  const list = await platform.prepare('SELECT * FROM bm_llm_log ORDER BY id DESC LIMIT ? OFFSET ?').all(pageSize, (pageNum - 1) * pageSize);
  res.json(ok({ list, total: c, pageNum, pageSize }));
});
llmRouter.get('/stats', async (req, res) => {
  const total = await platform.prepare('SELECT COUNT(*) c FROM bm_llm_log').get();
  const success = await platform.prepare('SELECT COUNT(*) c FROM bm_llm_log WHERE success=1').get();
  const avg = await platform.prepare('SELECT AVG(latency_ms) a FROM bm_llm_log').get();
  const byType = {};
  for (const r of await platform.prepare('SELECT call_type t, COUNT(*) c FROM bm_llm_log GROUP BY call_type').all()) byType[r.t] = r.c;
  res.json(ok({ total: total?.c ?? 0, successRate: (total?.c || 0) ? Math.round(100 * (success?.c || 0) / total.c) : 0, avgLatencyMs: avg?.a ? Math.round(avg.a) : 0, byType, currentOntologyVersion: await currentTag() }));
});
llmRouter.get('/routes', async (req, res) => {
  const eps = endpoints();
  res.json(ok(eps.map(e => ({
    name: e.name, model: e.model,
    host: (e.baseUrl || '').replace(/^https?:\/\//, '').split('/')[0],
    healthy: !!e.apiKey && !circuits[e.name].open,
    inUse: e.name === 'primary',
  }))));
});

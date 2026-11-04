import { createRouter, createWebHistory } from 'vue-router';
import { useUserStore } from '../store/user';

const routes = [
  { path: '/login', component: () => import('../views/login/index.vue'), meta: { title: '登录' } },
  {
    path: '/',
    component: () => import('../layout/MainLayout.vue'),
    redirect: '/architecture',
    children: [
      { path: 'architecture', component: () => import('../views/architecture/index.vue'), meta: { title: '架构全貌', subtitle: '实体全景 / 分层架构双视图' } },
      { path: 'ontology', component: () => import('../views/ontology/index.vue'), meta: { title: '本体管理', subtitle: '业务域 → 概念 → 关系与公理，版本化发布' } },
      { path: 'datasource', component: () => import('../views/datasource/index.vue'), meta: { title: '数据源绑定', subtitle: '数据不搬家，只建「概念 ↔ 物理列」映射' } },
      { path: 'glossary', component: () => import('../views/glossary/index.vue'), meta: { title: '统一口径', subtitle: '术语 · 指标 · 对账：口径卡与巡检' } },
      { path: 'knowledge', component: () => import('../views/knowledge/index.vue'), meta: { title: '知识库', subtitle: '制度文档 + 经验条目，改一条走审批' } },
      { path: 'trace', component: () => import('../views/trace/index.vue'), meta: { title: '证据链', subtitle: '问答 / 概念 / 映射 全程可追溯' } },
      { path: 'link', component: () => import('../views/link/index.vue'), meta: { title: '链路追溯', subtitle: '工单 → 变更 → 用例 → 发布 双向 BFS' } },
      { path: 'flow', component: () => import('../views/flow/index.vue'), meta: { title: '医嘱闭环', subtitle: '跨九库装配患者全流程时间线' } },
      { path: 'clinical', component: () => import('../views/clinical/index.vue'), meta: { title: '临床决策', subtitle: '病案内涵质控 × SHACL 双引擎互证' } },
      { path: 'gov', component: () => import('../views/gov/index.vue'), meta: { title: '数据治理', subtitle: '规则探针扫描，质量分与问题清单' } },
      { path: 'ask', component: () => import('../views/ask/index.vue'), meta: { title: '智能问数', subtitle: 'Ontology2SQL：LLM 只表达，白名单真执行' } },
      { path: 'cs', component: () => import('../views/cs/index.vue'), meta: { title: 'AI客服', subtitle: '工单智能诊断 · 跨库核对 · 一键处置' } },
      { path: 'value', component: () => import('../views/value/index.vue'), meta: { title: '价值实证', subtitle: 'A/B/C 三组对照与 MCP 开放' } },
      { path: 'lab', component: () => import('../views/lab/index.vue'), meta: { title: 'AI查询比对', subtitle: '三臂同题对照实验（沙盒）' } },
      { path: 'simulation', component: () => import('../views/simulation/index.vue'), meta: { title: '推演沙盘', subtitle: '施加扰动，本体传导波及链' } },
      { path: 'evolve', component: () => import('../views/evolve/index.vue'), meta: { title: '概念缺口', subtitle: '词表外说法 → AI 提案 → 人工裁决' } },
      { path: 'drift', component: () => import('../views/drift/index.vue'), meta: { title: '语义漂移', subtitle: '术语分叉与口径演进检测' } },
      { path: 'rca', redirect: '/cs' },
    ],
  },
];

const router = createRouter({ history: createWebHistory(), routes });
router.beforeEach((to) => {
  const user = useUserStore();
  if (!user.isLoggedIn && to.path !== '/login') return { path: '/login', query: { redirect: to.fullPath } };
  if (user.isLoggedIn && to.path === '/login') return '/';
  return true;
});
export default router;

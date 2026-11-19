import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { platform, ensureDatabases } from './db.js';
import { ok } from './common.js';
import { authRouter, requireAuth, authorize, seedUsers } from './auth.js';
import { llmRouter, llmEnabled } from './llm.js';
import { ontologyRouter } from './ontology.js';
import { releaseRouter, owlRouter } from './release.js';
import { metricRouter } from './metric.js';
import { datasourceRouter } from './datasource.js';
import { knowledgeRouter } from './knowledge.js';
import { csRouter } from './cs.js';
import { govRouter, reconcileRouter } from './gov.js';
import { linkRouter, traceRouter } from './link.js';
import { flowRouter, clinicalRouter } from './flow.js';
import { rcaRouter } from './rca.js';
import { archRouter, searchRouter, noticeRouter, valueRouter, labRouter, simRouter, mcpHandler } from './misc.js';
import { seedDemoDbs } from './seed/demo.js';
import { seedPlatformData } from './seed/platform.js';
import { runInspect } from './misc.js';

export const app = express();
app.use(express.json({ limit: '20mb' }));

// ---------- 安全中间件 ----------
app.use(helmet());
app.use(cors({ origin: config.corsOrigins }));
// 登录接口限流：15 次/分钟
const loginLimiter = rateLimit({ windowMs: 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false, message: '登录请求过于频繁，请稍后再试' });

// ---------- 路由 ----------
app.use(requireAuth);
app.use(authorize);
// 登录限流仅作用于登录端点
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', authRouter);
app.use('/api/llm', llmRouter);
app.use('/api/ontology', ontologyRouter);
app.use('/api', ontologyRouter); // 原版 DomainController/ConceptController 等直接挂 /api 根（/api/domain/list 等）
app.use('/api/ontology', owlRouter); // OWL 导入（owlRouter 内部路由为 /import/preview，与前端 /api/ontology/import/preview 对齐）
app.use('/api/release', releaseRouter);
app.use('/api/metric', metricRouter);
app.use('/api/datasource', datasourceRouter);
app.use('/api', datasourceRouter); // /api/mapping/* 与 /api/instance/* 挂根（与原版 MappingController 一致）
app.use('/api/knowledge', knowledgeRouter);
app.use('/api/cs', csRouter);
app.use('/api/recon', (req, res, next) => { req.url = '/recon' + req.url; csRouter(req, res, next); }); // /api/recon/diffs → csRouter /recon/diffs
app.use('/api/gov', govRouter);
app.use('/api/reconcile', reconcileRouter);
app.use('/api/link', linkRouter);
app.use('/api', linkRouter); // /api/impact/analyze 挂根
app.use('/api/trace', traceRouter);
app.use('/api/rca', rcaRouter);
app.use('/api/flow', flowRouter);
app.use('/api', clinicalRouter);          // 质控 /api/qc/* 与 RDF/SHACL /api/rdf/*
app.use('/api/architecture', archRouter);
app.use('/api/search', searchRouter);
app.use('/api/notice', noticeRouter);
app.use('/api/value', valueRouter);
app.use('/api/lab', labRouter);
app.use('/api/simulation', simRouter);
app.use('/mcp', mcpHandler);

// 健康检查
app.get('/api/health', (req, res) => {
  res.json(ok({ status: 'up', llm: llmEnabled() ? 'configured' : 'degraded', time: new Date().toISOString() }));
});

// ---------- 统一错误处理（HTTP 200 + code 信封，与原版一致） ----------
app.use((err, req, res, next) => {
  if (err) {
    const msg = err.name === 'BizException' || err.type === 'entity.parse.failed' ? (err.message || '请求错误') : `系统异常: ${err.message}`;
    if (err.name !== 'BizException') console.error('[BeModel] ERROR', req.method, req.url, err);
    res.status(200).json({ code: 500, msg, data: null });
  }
});

// ---------- 巡检定时器（每 30 分钟，等价 cron 0 0/30 * * * *） ----------
setInterval(() => {
  try { runInspect().catch(e => console.error('[BeModel] 巡检失败', e.message)); } catch (e) { console.error('[BeModel] 巡检失败', e.message); }
}, config.inspectIntervalMs);

// ---------- 启动流程（异步：建库 → 建表 → 播种 → 监听） ----------
async function bootstrap() {
  // 1. 创建平台库与各业务库
  await ensureDatabases();
  // 2. 平台元数据库建表
  await platform.initSchema();
  console.log('[BeModel] 平台元数据库表结构已就绪');

  // 3. 播种（确定性 + 幂等）；演示种子与演示账号仅开发环境执行，生产走独立初始化
  if (!config.isProd) {
    console.log('[BeModel] 正在初始化演示数据（确定性、幂等）…');
    const demoSeeded = await seedDemoDbs();
    if (demoSeeded) console.log('[BeModel] 九个演示业务库已生成（41 名患者住院医嘱全闭环，预埋 LIS 撤销码裂缝）');
    else console.log('[BeModel] 演示业务库已存在且数据达标，跳过播种');
    await seedUsers();
    if (await seedPlatformData()) console.log('[BeModel] 平台本体种子已写入（16 域 / 概念 / 关系公理 / 指标 / 规则 / 映射 / 治理规则 / 链路故事线 / 知识条目）');
    else console.log('[BeModel] 平台本体种子已存在，跳过');
  } else {
    // 云上生产实例（魔搭/演示环境）默认也播业务演示库：问数/临床闭环依赖九库数据。
    // 真生产可用 DEMO_SEED=0 显式关闭（届时业务问题诚实降级为语义缺口，不误报库错误）。
    if (process.env.DEMO_SEED !== '0') {
      const demoSeeded = await seedDemoDbs();
      console.log(demoSeeded ? '[BeModel] 生产演示模式：九个业务演示库已生成' : '[BeModel] 生产演示模式：业务库数据达标，跳过播种');
    }
    await seedUsers();
    await seedPlatformData();
  }

  // 4. 托管前端静态资源（SPA history fallback）
  const webDist = config.webDist;
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    // Express 5 不再支持 '*' 通配路由，用正则中间件实现 SPA history 回退
    app.get(/^(?!\/api\/|\/mcp).*/, (req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
    console.log(`[BeModel] 前端静态资源托管：${webDist}`);
  }

  // 5. 监听
  app.listen(config.port, config.host, () => {
    console.log(`[BeModel] 后端已启动 http://${config.host}:${config.port}（演示账号 admin/admin123 · modeler/model123 · reviewer/reviewer123 · viewer/viewer123）`);
    console.log(`[BeModel] LLM 网关：${llmEnabled() ? '已配置（主备路由+熔断）' : '未配置 API Key，全链路规则/模板降级'}`);
  });
}

bootstrap().catch(err => {
  console.error('[BeModel] 启动失败：', err);
  process.exit(1);
});

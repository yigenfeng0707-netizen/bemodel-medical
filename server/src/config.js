import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 可选 .env 加载（与原版 spring.config.import optional:file:.env.properties 对应）
function loadDotEnv() {
  for (const p of [path.resolve(__dirname, '../../.env'), path.resolve(__dirname, '../.env'), path.resolve(__dirname, '../../..', '.env')]) {
    try {
      if (fs.existsSync(p)) {
        for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
          const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
          if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      }
    } catch { /* ignore */ }
  }
}
loadDotEnv();

const env = process.env;
const isProd = env.NODE_ENV === 'production';

// ---------- PostgreSQL 连接配置（魔搭容器内自装 / 阿里云 RDS 通用） ----------
const pgConn = {
  host: env.PG_HOST || '127.0.0.1',
  port: parseInt(env.PG_PORT || '5432', 10),
  user: env.PG_USER || 'bemodel',
  password: env.PG_PASSWORD || 'bemodel',
};
// 测试隔离：DATA_DIR 存在时，为平台库与各业务库追加测试后缀，避免多套件互相污染
const testSuffix = env.DATA_DIR ? '_' + path.basename(env.DATA_DIR).replace(/[^A-Za-z0-9_]/g, '_') : '';
// 平台元数据库名
const platformDb = (env.PG_PLATFORM_DB || 'bemodel_platform') + testSuffix;
// 各业务数据源对应的 database 名（裸表名天然隔离，与原 SQLite 多文件语义一致）
const demoDbs = {
  DS_HIS: 'bemodel_his' + testSuffix,
  DS_LIS: 'bemodel_lis' + testSuffix,
  DS_CHARGE: 'bemodel_charge' + testSuffix,
  DS_PHARMACY: 'bemodel_pharmacy' + testSuffix,
  DS_OPD: 'bemodel_opd' + testSuffix,
  DS_EMR: 'bemodel_emr' + testSuffix,
  DS_PACS: 'bemodel_pacs' + testSuffix,
  DS_NURSE: 'bemodel_nurse' + testSuffix,
  DS_MATERIAL: 'bemodel_material' + testSuffix,
  DS_LAB: 'bemodel_lab' + testSuffix,
};

// ---------- 密钥强制校验（生产环境缺失即拒绝启动） ----------
function requireEnv(name) {
  if (!env[name]) {
    console.error(`[BeModel] 致命：生产环境缺少必填环境变量 ${name}，拒绝启动。`);
    process.exit(1);
  }
}
if (isProd) {
  requireEnv('JWT_SECRET');
  requireEnv('APP_SECRET_KEY');
  requireEnv('PG_USER');
  requireEnv('PG_PASSWORD');
}

export const config = {
  env: env.NODE_ENV || 'development',
  isProd,
  port: parseInt(env.PORT || '7860', 10), // 魔搭占用 8080，默认 7860
  host: env.HOST || '0.0.0.0', // 容器内须监听 0.0.0.0

  // PostgreSQL
  pg: { ...pgConn, platformDb, demoDbs },

  // 密钥（生产强制，开发/测试用默认）
  jwtSecret: env.JWT_SECRET || 'bemodel-dev-jwt-secret-do-not-use-in-prod',
  appSecretKey: env.APP_SECRET_KEY || 'bemodel-dev-app-secret-do-not-use-in-prod',

  // LLM 网关：主备双端点（DEEPSEEK_* 为兼容原版的别名）
  llm: {
    primary: {
      name: 'primary',
      baseUrl: env.LLM_BASE_URL || env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      apiKey: env.LLM_API_KEY || env.DEEPSEEK_API_KEY || '',
      model: env.LLM_MODEL || env.DEEPSEEK_MODEL || 'deepseek-chat',
    },
    backup: {
      name: 'backup',
      baseUrl: env.LLM_BACKUP_BASE_URL || env.DEEPSEEK_BACKUP_BASE_URL || '',
      apiKey: env.LLM_BACKUP_API_KEY || env.DEEPSEEK_BACKUP_API_KEY || '',
      model: env.LLM_BACKUP_MODEL || env.DEEPSEEK_BACKUP_MODEL || '',
    },
    timeoutSeconds: parseInt(env.LLM_TIMEOUT_SECONDS || '60', 10),
    maxTokens: parseInt(env.LLM_MAX_TOKENS || '4096', 10),
    callTimeouts: { MAPPING_SUGGEST: 240000, LAB_A: 180000, LAB_B: 180000 },
    callMaxTokens: { LAB_A: 8192, LAB_B: 8192 },
    failureThreshold: 2, cooldownMs: 5 * 60 * 1000,
  },

  embedding: {
    baseUrl: env.EMBEDDING_BASE_URL || 'http://localhost:11434/v1',
    model: env.EMBEDDING_MODEL || 'bge-m3',
    apiKey: env.EMBEDDING_API_KEY || '',
    timeoutMs: parseInt(env.EMBEDDING_TIMEOUT_MS || '3000', 10),
  },

  // 问数场景数据源白名单（空 = 不过滤）。复现版默认放开九库演示环境
  semanticSceneDs: (env.SEMANTIC_SCENE_DS || 'DS_HIS,DS_LIS,DS_CHARGE,DS_PHARMACY,DS_EMR,DS_PACS,DS_OPD,DS_NURSE,DS_MATERIAL')
    .split(',').map(s => s.trim()).filter(Boolean),

  chunk: { size: 500, overlap: 50 },
  mapping: { llmBatchSize: 25, topKConcepts: 25, llmBudgetSeconds: 280 },
  proposalTopN: 10,
  inspectIntervalMs: 30 * 60 * 1000,
  reconcileIntervalMs: 24 * 3600 * 1000,

  // 前端静态资源目录（由后端托管，魔搭/阿里云同镜像）
  webDist: env.WEB_DIST || path.resolve(__dirname, '../../web/dist'),

  // MCP 端点 API Key（缺失则拒绝访问）
  mcpApiKey: env.MCP_API_KEY || '',

  // 跨域白名单（生产收紧）
  corsOrigins: (env.CORS_ORIGINS || (isProd ? '' : 'http://localhost:5173')).split(',').map(s => s.trim()).filter(Boolean),
};

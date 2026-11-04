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

const dataDir = process.env.DATA_DIR || path.resolve(__dirname, '../../data');
fs.mkdirSync(dataDir, { recursive: true });

export const config = {
  port: parseInt(process.env.PORT || '18080', 10),
  dataDir,
  platformDb: path.join(dataDir, process.env.PLATFORM_DB || 'bemodel_platform.db'),

  jwtSecret: process.env.JWT_SECRET || 'bemodel-dev-jwt-secret-do-not-use-in-prod',
  appSecretKey: process.env.APP_SECRET_KEY || 'bemodel-dev-app-secret-do-not-use-in-prod',

  // LLM 网关：主备双端点（DEEPSEEK_* 为兼容原版的别名）
  llm: {
    primary: {
      name: 'primary',
      baseUrl: process.env.LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      apiKey: process.env.LLM_API_KEY || process.env.DEEPSEEK_API_KEY || '',
      model: process.env.LLM_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    },
    backup: {
      name: 'backup',
      baseUrl: process.env.LLM_BACKUP_BASE_URL || process.env.DEEPSEEK_BACKUP_BASE_URL || '',
      apiKey: process.env.LLM_BACKUP_API_KEY || process.env.DEEPSEEK_BACKUP_API_KEY || '',
      model: process.env.LLM_BACKUP_MODEL || process.env.DEEPSEEK_BACKUP_MODEL || '',
    },
    timeoutSeconds: parseInt(process.env.LLM_TIMEOUT_SECONDS || '60', 10),
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS || '4096', 10),
    // 各 callType 覆盖（毫秒超时 / 最大 token）
    callTimeouts: { MAPPING_SUGGEST: 240000, LAB_A: 180000, LAB_B: 180000 },
    callMaxTokens: { LAB_A: 8192, LAB_B: 8192 },
    failureThreshold: 2, cooldownMs: 5 * 60 * 1000,
  },

  embedding: {
    baseUrl: process.env.EMBEDDING_BASE_URL || 'http://localhost:11434/v1',
    model: process.env.EMBEDDING_MODEL || 'bge-m3',
    apiKey: process.env.EMBEDDING_API_KEY || '',
    timeoutMs: parseInt(process.env.EMBEDDING_TIMEOUT_MS || '3000', 10),
  },

  // 问数场景数据源白名单（空 = 不过滤）。复现版默认放开九库演示环境
  semanticSceneDs: (process.env.SEMANTIC_SCENE_DS || 'DS_HIS,DS_LIS,DS_CHARGE,DS_PHARMACY,DS_EMR,DS_PACS,DS_OPD,DS_NURSE,DS_MATERIAL')
    .split(',').map(s => s.trim()).filter(Boolean),

  chunk: { size: 500, overlap: 50 },
  mapping: { llmBatchSize: 25, topKConcepts: 25, llmBudgetSeconds: 280 },
  proposalTopN: 10,
  // 每日对账巡检时刻（简化为定时器，毫秒）
  inspectIntervalMs: 30 * 60 * 1000,
  reconcileIntervalMs: 24 * 3600 * 1000,

  demoDbs: {
    DS_HIS: path.join(dataDir, 'demo_his.db'),
    DS_LIS: path.join(dataDir, 'demo_lis.db'),
    DS_CHARGE: path.join(dataDir, 'demo_charge.db'),
    DS_PHARMACY: path.join(dataDir, 'demo_pharmacy.db'),
    DS_OPD: path.join(dataDir, 'demo_opd.db'),
    DS_EMR: path.join(dataDir, 'demo_emr.db'),
    DS_PACS: path.join(dataDir, 'demo_pacs.db'),
    DS_NURSE: path.join(dataDir, 'demo_nurse.db'),
    DS_MATERIAL: path.join(dataDir, 'demo_material.db'),
    DS_LAB: path.join(dataDir, 'bemodel_lab.db'),
  },
};

// 测试环境初始化辅助：PG 数据库创建 + 建表 + 播种（每个测试套件通过 DATA_DIR 隔离）
import { platform, ensureDatabases } from '../src/db.js';
import { seedDemoDbs } from '../src/seed/demo.js';
import { seedPlatformData } from '../src/seed/platform.js';
import { seedUsers, issueToken } from '../src/auth.js';

/**
 * 初始化测试环境：创建隔离的 PG 数据库、建表、播种。
 * 返回 { platform, adminToken } 供测试使用。
 */
export async function initTestEnv() {
  // 1. 创建平台库与各业务库（DATA_DIR 后缀隔离）
  await ensureDatabases();
  // 2. 平台元数据库建表
  await platform.initSchema();
  // 3. 播种业务库（确定性、幂等）
  await seedDemoDbs(true);
  // 4. 播种平台本体种子
  await seedPlatformData(true);
  // 5. 播种用户
  await seedUsers();
  // 6. 签发 admin token
  const admin = await platform.prepare("SELECT * FROM bm_user WHERE username='admin'").get();
  const adminToken = issueToken(admin);
  return { platform, adminToken };
}

/**
 * 重置测试数据库（删除所有表并重建，用于需要干净状态的测试）。
 */
export async function resetTestDb() {
  const tables = await platform.prepare("SELECT tablename FROM pg_tables WHERE schemaname='public'").all();
  for (const t of tables) {
    await platform.prepare(`DROP TABLE IF EXISTS "${t.tablename}" CASCADE`).run();
  }
  await platform.initSchema();
}

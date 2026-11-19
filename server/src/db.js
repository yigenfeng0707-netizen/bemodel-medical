import { config } from './config.js';
import { makeAdapter, createPool, toPgPlaceholders } from './pg.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 数据访问层：PostgreSQL 版。
 * 保持与原 SQLite 版一致的导出 API（platform / businessDb / probeOne / probeRows / probeCount / now 等），
 * 但数据库访问变为异步（pg 驱动本质为异步，业务模块需 await 数据库调用）。
 *
 * 多库机制：一个 PG 实例，每个 dsCode 一个独立 database，裸表名天然隔离（与原 SQLite 多文件语义一致）。
 */

// ---------- 平台元数据库连接池 ----------
const platformPool = createPool({ ...config.pg, database: config.pg.platformDb });
// 启动时建表（执行 schema.pg.sql，多语句 DDL）
async function initPlatformSchema() {
  const schemaFile = new URL('./schema.pg.sql', import.meta.url);
  const ddl = fs.readFileSync(schemaFile, 'utf8');
  await platformPool.query(ddl);
}
export const platform = makeAdapter(platformPool);
platform._pool = platformPool;
platform.initSchema = initPlatformSchema;

// ---------- 数据库初始化（连接 postgres 维护库，创建平台库与各业务库） ----------
const adminPool = createPool({ ...config.pg, database: 'postgres' });

export async function ensureDatabases() {
  const dbNames = [config.pg.platformDb, ...Object.values(config.pg.demoDbs)];
  for (const dbName of dbNames) {
    const res = await adminPool.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbName]);
    if (!res.rows.length) {
      await adminPool.query(`CREATE DATABASE "${dbName}"`);
      console.log(`[BeModel] 已创建数据库 ${dbName}`);
    }
  }
}

// ---------- 演示/业务库连接池注册表（按 dsCode 缓存连接池与适配对象） ----------
const bizCache = new Map();

export async function businessDb(dsCode) {
  if (bizCache.has(dsCode)) return bizCache.get(dsCode);
  const dbName = config.pg.demoDbs[dsCode];
  if (!dbName) throw new Error(`未知数据源：${dsCode}`);
  const pool = createPool({ ...config.pg, database: dbName });
  const adapter = makeAdapter(pool);
  bizCache.set(dsCode, adapter);
  return adapter;
}

// 按 database 名反查 dsCode（供 datasource.js 等按库名接入）
export async function businessDbByFile(dbName) {
  const dsCode = Object.entries(config.pg.demoDbs).find(([, v]) => v === dbName)?.[0] || null;
  if (dsCode) return { dsCode, db: await businessDb(dsCode) };
  // 未知库：直接连
  const pool = createPool({ ...config.pg, database: dbName });
  const adapter = makeAdapter(pool);
  return { dsCode: null, db: adapter };
}

export async function biz(dsCode) {
  try { return await businessDb(dsCode); } catch { return null; }
}

// 在业务库上执行只读探针 SQL（queryForObject 单值 / rows 多行）
export async function probeOne(dsCode, sql, params = []) {
  const db = await businessDb(dsCode);
  const row = await db.prepare(sql).get(...params);
  if (!row) return null;
  const v = Object.values(row)[0];
  return v === null || v === undefined ? null : v;
}
export async function probeRows(dsCode, sql, params = [], maxRows = 100) {
  const db = await businessDb(dsCode);
  const s = /(\blimit\b)/i.test(sql) ? sql : sql + ` LIMIT ${maxRows}`;
  return await db.prepare(s).all(...params);
}
export async function probeCount(dsCode, sql, params = []) {
  const v = await probeOne(dsCode, sql, params);
  return v === null ? 0 : Number(v);
}

// ---------- 通用小工具（同步） ----------
export function now() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
export function dateOf(d = new Date()) { return now().slice(0, 10); }
export function addDays(base, days) { const d = new Date(base); d.setDate(d.getDate() + days); return d; }
export function fmtDate(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function fmtDateTime(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${fmtDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 导出占位符转换工具（供 schema/播种 DDL 使用）
export { toPgPlaceholders };

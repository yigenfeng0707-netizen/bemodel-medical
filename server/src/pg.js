import { Pool, types } from 'pg';

// int8(BIGINT) 默认解析为字符串以保 2^53 精度；本应用 id/计数均为小整数，
// SQLite(node:sqlite) 把 INTEGER 返回为 number——按 SQLite 语义统一解析为数字，避免调用端 '1' !== 1 的类型漂移
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

/**
 * PG 适配层：保持 SQLite 风格的 prepare(sql).get/all/run/exec 调用形态，
 * 内部把 ? 占位符转换为 PG 的 $1,$2,...，并通过 pg 连接池执行。
 *
 * 注意：PG 是异步的，适配层返回 Promise，业务模块的数据库调用需加 await。
 * 这是 node:sqlite(同步) → pg(异步) 的固有差异，无法通过适配层隐藏。
 *
 * 业务模块的改动主要是：DB 调用加 await、路由 handler 改 async；
 * SQLite 专有方言(INSERT OR IGNORE / PRAGMA / sqlite_master / datetime('now') 等)
 * 仍需逐个适配为 PG 方言。
 */

// ---------- ? 占位符 → $1,$2,...（状态机，感知单/双引号字符串与标识符） ----------
export function toPgPlaceholders(sql) {
  const s = String(sql || '');
  let out = '';
  let n = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'") {
      // 单引号字符串字面量，原样保留（含 '' 转义），不替换内部 ?
      out += ch; i++;
      while (i < s.length) {
        if (s[i] === "'") {
          if (s[i + 1] === "'") { out += "''"; i += 2; continue; }
          out += "'"; i++; break;
        }
        out += s[i]; i++;
      }
      continue;
    }
    if (ch === '"') {
      // 双引号标识符，原样保留（含 "" 转义）
      out += ch; i++;
      while (i < s.length) {
        if (s[i] === '"') {
          if (s[i + 1] === '"') { out += '""'; i += 2; continue; }
          out += '"'; i++; break;
        }
        out += s[i]; i++;
      }
      continue;
    }
    if (ch === '?') {
      n++;
      out += '$' + n;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// ---------- 适配对象工厂 ----------
const isInsert = (sql) => /^\s*INSERT/i.test(sql);
const stripTrailingSemi = (sql) => String(sql).replace(/;+\s*$/, '').trim();

/**
 * 用连接池构造一个 SQLite 风格的适配对象。
 * prepare(sql) 返回 { get, all, run, exec }。
 * - get: 取首行，无行返回 null
 * - all: 取多行
 * - run: INSERT 自动补 RETURNING id，返回 { lastInsertRowid, changes }
 *        （联合主键无 id 列的表，捕获错误后回退为无 RETURNING 执行）
 * - exec: 执行多语句 DDL（简单查询协议）；不带参调用时执行 prepare 捕获的 SQL
 *
 * 事务支持（对应 node:sqlite 的 db.exec('BEGIN') 用法）：
 * 适配层顶层提供 exec(sql)，BEGIN 时从池中钉住一条专用连接，
 * 后续 get/all/run 都走该连接，COMMIT/ROLLBACK 后释放——
 * 否则 pool 每次查询取不同连接，事务隔离形同虚设。
 */
export function makeAdapter(pool) {
  // 事务钉住的专用连接（null = 非事务态，走池）
  let txnClient = null;
  const conn = () => txnClient || pool;

  // 批缓冲（播种加速）：beginBatch 后 run() 把同一 INSERT 的参数按行聚合，
  // flushBatch 时合并为多值 INSERT 一次发送，把数万次网络往返压到几十次。
  let batchQueue = null;

  async function flushBatch() {
    if (!batchQueue) return;
    const queue = batchQueue;
    batchQueue = null;
    for (const [baseSql, rows] of queue) {
      // 解析 INSERT INTO <table>[(cols)] VALUES (?,?,...)——VALUES 括号内的 ? 个数即列数
      const m = /^(INSERT\s+INTO\s+"?[\w."]+"?(?:\s*\([^)]*\))?)\s*VALUES\s*\((\?(?:\s*,\s*\?)*)\)\s*$/is.exec(baseSql);
      if (!m || !rows.length) throw new Error(`批缓冲仅支持 INSERT INTO ... VALUES 形态：${baseSql.slice(0, 80)}`);
      const k = m[2].split(',').length;
      for (let i = 0; i < rows.length; i += 300) {
        const chunk = rows.slice(i, i + 300);
        const groups = chunk.map((_, ri) => `(${Array.from({ length: k }, (_, ci) => '$' + (ri * k + ci + 1)).join(',')})`).join(',');
        await conn().query(`${m[1]} VALUES ${groups}`, chunk.flat());
      }
    }
  }

  const adapter = {
    prepare(sql) {
      return {
        async get(...params) {
          if (batchQueue) await flushBatch();
          const res = await conn().query(toPgPlaceholders(sql), params);
          return res.rows[0] || null;
        },
        async all(...params) {
          if (batchQueue) await flushBatch();
          const res = await conn().query(toPgPlaceholders(sql), params);
          return res.rows;
        },
        async run(...params) {
          // 批缓冲模式：INSERT 按行聚合，非 INSERT 先冲刷（保证写读顺序）
          if (batchQueue && isInsert(sql)) {
            const key = stripTrailingSemi(sql);
            if (!batchQueue.has(key)) batchQueue.set(key, []);
            batchQueue.get(key).push(params);
            return { lastInsertRowid: null, changes: 1 };
          }
          if (batchQueue) await flushBatch();
          if (isInsert(sql)) {
            const base = stripTrailingSemi(sql);
            try {
              const res = await conn().query(toPgPlaceholders(base) + ' RETURNING id', params);
              const id = res.rows[0] ? Number(res.rows[0].id) : null;
              return { lastInsertRowid: id, changes: res.rowCount };
            } catch (e) {
              // 仅在“id 列不存在”（联合主键表等）时回退为无 RETURNING 执行。
              // 必须用错误码 42703 精确判断：执行期错误（NOT NULL/唯一键冲突等）会把事务标记为 aborted，
              // 若此时盲目二次执行，只会得到 25P02 并吞掉真实错误。
              if (e.code === '42703' || /column "id"/i.test(e.message)) {
                const res = await conn().query(toPgPlaceholders(base), params);
                return { lastInsertRowid: null, changes: res.rowCount };
              }
              throw e;
            }
          }
          const res = await conn().query(toPgPlaceholders(sql), params);
          return { lastInsertRowid: null, changes: res.rowCount };
        },
        async exec(s) {
          // 兼容两种调用形态：prepare(sql).exec()（无参，用捕获的 sql）与 prepare(sql).exec(multiSql)
          await conn().query(s === undefined ? sql : s);
        },
      };
    },

    // 顶层 exec：多语句 DDL / BEGIN / COMMIT / ROLLBACK
    async exec(sql) {
      const stmt = String(sql || '').trim().toUpperCase();
      if (stmt === 'BEGIN' || stmt.startsWith('BEGIN ')) {
        if (txnClient) return; // 已在事务中，避免嵌套 BEGIN
        txnClient = await pool.connect();
        await txnClient.query('BEGIN');
        return;
      }
      if (stmt === 'COMMIT' || stmt === 'ROLLBACK') {
        if (!txnClient) return; // 无钉住连接时语句已逐条自动提交，事务指令空操作
        try { await txnClient.query(stmt); } finally {
          txnClient.release();
          txnClient = null;
        }
        return;
      }
      await conn().query(sql);
    },

    // 批缓冲开关：播种等大批量写入场景用；get/all/run 会在必要时自动冲刷
    beginBatch() { batchQueue = new Map(); },
    async flushBatch() { await flushBatch(); },
  };
  return adapter;
}

// ---------- 连接池工厂 ----------
export function createPool(conn) {
  // 池上限：多库架构下池数量 = 1 平台库 + N 业务库，总连接数须低于 PG max_connections。
  // 测试进程（DATA_DIR 标记）并行跑多文件，每文件 12 池，上限调低防 "too many clients"。
  const isTest = !!process.env.DATA_DIR;
  const max = parseInt(process.env.PG_POOL_MAX || (isTest ? '2' : '5'), 10);
  const pool = new Pool({ ...conn, max });
  pool.on('error', (err) => {
    console.error('[PG] idle client error', err.message);
  });
  return pool;
}

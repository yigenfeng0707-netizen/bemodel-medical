import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import express from 'express';
import { platform, now } from './db.js';
import { BizException, ok } from './common.js';
import { config } from './config.js';

// ---------- JWT（HS256，2 小时有效期；jti 用于登出吊销） ----------
const TTL_MS = 2 * 3600 * 1000;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
export function issueToken(user) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64u(JSON.stringify({
    sub: user.username, role: user.role, displayName: user.display_name || '',
    jti: crypto.randomUUID(),
    iat: Math.floor(Date.now() / 1000), exp: Math.floor((Date.now() + TTL_MS) / 1000),
  }));
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}
export function parseToken(token) {
  try {
    const [h, p, s] = String(token).split('.');
    if (!h || !p || !s) return null;
    const expect = crypto.createHmac('sha256', config.jwtSecret).update(`${h}.${p}`).digest('base64url');
    if (s !== expect) return null;
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch { return null; }
}

// ---------- 登录失败锁定（账号维度，进程内计数，与 IP 限流互补） ----------
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
const failures = new Map(); // username -> { count, lockedUntil }
function lockedUntil(username) {
  const f = failures.get(username);
  if (!f) return 0;
  if (f.lockedUntil && f.lockedUntil <= Date.now()) { failures.delete(username); return 0; }
  return f.lockedUntil || 0;
}
function registerFailure(username) {
  const f = failures.get(username) || { count: 0, lockedUntil: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILURES) { f.lockedUntil = Date.now() + LOCK_MS; f.count = 0; }
  failures.set(username, f);
}

// ---------- 登出吊销（jti 黑名单，过期即清理） ----------
const revoked = new Map(); // jti -> exp(ms)
function isRevoked(jti) {
  if (!jti) return false;
  const exp = revoked.get(jti);
  if (!exp) return false;
  if (exp <= Date.now()) { revoked.delete(jti); return false; }
  return true;
}

// ---------- 登录审计（成功/失败/锁定均留痕） ----------
async function auditLogin(req, username, success, result) {
  const ip = req.ip || req.socket?.remoteAddress || '';
  const ua = String(req.headers['user-agent'] || '').slice(0, 500);
  await platform.prepare('INSERT INTO bm_login_audit(username, ip, user_agent, success, result) VALUES (?,?,?,?,?)')
    .run(username, ip, ua, success ? 1 : 0, result);
}

// ---------- 角色权限 ----------
export const ROLES = ['ADMIN', 'EDITOR', 'REVIEWER', 'VIEWER'];
function currentReq(req) { return req.auth || null; }
export function currentUser(req) { return currentReq(req); }
export function hasAnyRole(req, ...roles) {
  const a = currentReq(req);
  return !!(a && roles.includes(a.role));
}

// 权限矩阵（对应原版 SecurityConfig）：
// - POST /api/auth/login 放行
// - POST /api/cs/ask、/api/cs/clarify/**、/api/search、/api/cs/feedback、/api/recon/diffs（只读型）全角色
// - GET /api/** 全角色
// - POST/PUT/DELETE /api/** 仅 ADMIN/EDITOR（transition 类额外放行 REVIEWER）
// - 非 /api/** 放行
export function requireAuth(req, res, next) {
  // 魔搭禁用 Authorization 头，优先读 X-Token；本地开发保留 Bearer 兼容
  const xToken = req.headers['x-token'] || '';
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  const token = xToken || (m ? m[1] : '');
  const claims = token ? parseToken(token) : null;
  if (claims && !isRevoked(claims.jti)) {
    req.auth = { username: claims.sub, role: claims.role, displayName: claims.displayName, jti: claims.jti, exp: claims.exp };
  }
  next();
}
function deny(res, code, msg) { res.status(code).json({ code, msg }); }

export function authorize(req, res, next) {
  const path = req.path;
  if (!path.startsWith('/api/')) return next();
  if (req.method === 'OPTIONS') return next();
  // 认证类端点（login/me/logout）自行鉴权，不进入业务写操作角色矩阵
  if (path.startsWith('/api/auth/') || path === '/api/health' || path.startsWith('/mcp')) return next();
  const a = currentReq(req);
  if (!a) return deny(res, 401, '未登录或已过期');
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  // 只读型 POST 全角色开放（问数/搜索/澄清/评议/探针执行类）
  const openPosts = [
    '/api/cs/ask', '/api/cs/feedback', '/api/cs/clarify/',
    '/api/search', '/api/rdf/validate/', '/api/metric/evaluate', '/api/ontology/relation/closure',
    '/api/ontology/check', '/api/reconcile/run/', '/api/ontology/import/preview', '/api/proposal/run',
  ];
  if (req.method === 'POST') {
    if (openPosts.some(p => path === p || path.startsWith(p))) return next();
    if (path.startsWith('/api/recon/diffs')) return next();
  }
  const transitionLike = /\/(transition|publish|claim|resolve|adopt|reject|classify|approve)\b/.test(path) || path.includes('/transition/');
  const needEditor = ['POST', 'PUT', 'DELETE'].includes(req.method);
  if (needEditor) {
    if (transitionLike) {
      if (!['ADMIN', 'EDITOR', 'REVIEWER'].includes(a.role)) return deny(res, 403, '权限不足');
    } else if (!['ADMIN', 'EDITOR'].includes(a.role)) {
      return deny(res, 403, '权限不足');
    }
  }
  next();
}

// ---------- 路由 ----------
export const authRouter = express.Router();
authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const name = String(username || '');
  if (lockedUntil(name) > Date.now()) {
    await auditLogin(req, name, false, 'LOCKED');
    throw new BizException('失败次数过多，账号已临时锁定，请 15 分钟后再试');
  }
  const user = await platform.prepare('SELECT * FROM bm_user WHERE username=?').get(name);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    registerFailure(name);
    await auditLogin(req, name, false, 'BAD_CREDENTIALS');
    throw new BizException('用户名或密码错误');
  }
  failures.delete(name);
  await auditLogin(req, name, true, 'SUCCESS');
  res.json(ok({ token: issueToken(user), username: user.username, displayName: user.display_name, role: user.role }));
});
authRouter.post('/logout', (req, res) => {
  const a = currentReq(req);
  if (!a) return deny(res, 401, '未登录或已过期');
  if (a.jti && a.exp) revoked.set(a.jti, a.exp * 1000);
  res.json(ok({ loggedOut: true }));
});
authRouter.get('/me', async (req, res) => {
  const a = currentReq(req);
  if (!a) return deny(res, 401, '未登录或已过期');
  const user = await platform.prepare('SELECT username, display_name, role FROM bm_user WHERE username=?').get(a.username);
  res.json(ok({ username: user.username, displayName: user.display_name, role: user.role }));
});

export async function seedUsers() {
  const ins = platform.prepare('INSERT INTO bm_user(username, password_hash, display_name, role) VALUES (?,?,?,?) ON CONFLICT(username) DO NOTHING');
  await ins.run('admin', bcrypt.hashSync('admin123', 12), '平台管理员', 'ADMIN');
  await ins.run('modeler', bcrypt.hashSync('model123', 12), '建模工程师', 'EDITOR');
  await ins.run('reviewer', bcrypt.hashSync('reviewer123', 12), '本体评审员', 'REVIEWER');
  await ins.run('viewer', bcrypt.hashSync('viewer123', 12), '只读访客', 'VIEWER');
}

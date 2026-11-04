import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import express from 'express';
import { platform, now } from './db.js';
import { BizException, ok } from './common.js';
import { config } from './config.js';

// ---------- JWT（HS256，12 小时有效期，与原版一致） ----------
const TTL_MS = 12 * 3600 * 1000;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
export function issueToken(user) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64u(JSON.stringify({
    sub: user.username, role: user.role, displayName: user.display_name || '',
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
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  const claims = m ? parseToken(m[1]) : null;
  if (claims) req.auth = { username: claims.sub, role: claims.role, displayName: claims.displayName };
  next();
}
function deny(res, code, msg) { res.status(code).json({ code, msg }); }

export function authorize(req, res, next) {
  const path = req.path;
  if (!path.startsWith('/api/')) return next();
  if (req.method === 'OPTIONS') return next();
  if (path === '/api/auth/login' || path === '/api/health' || path.startsWith('/mcp')) return next();
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
authRouter.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = platform.prepare('SELECT * FROM bm_user WHERE username=?').get(username || '');
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    throw new BizException('用户名或密码错误');
  }
  res.json(ok({ token: issueToken(user), username: user.username, displayName: user.display_name, role: user.role }));
});
authRouter.get('/me', (req, res) => {
  const a = currentReq(req);
  if (!a) return deny(res, 401, '未登录或已过期');
  const user = platform.prepare('SELECT username, display_name, role FROM bm_user WHERE username=?').get(a.username);
  res.json(ok({ username: user.username, displayName: user.display_name, role: user.role }));
});

export function seedUsers() {
  const ins = platform.prepare('INSERT OR IGNORE INTO bm_user(username, password_hash, display_name, role) VALUES (?,?,?,?)');
  ins.run('admin', bcrypt.hashSync('admin123', 10), '平台管理员', 'ADMIN');
  ins.run('modeler', bcrypt.hashSync('model123', 10), '建模工程师', 'EDITOR');
  ins.run('reviewer', bcrypt.hashSync('reviewer123', 10), '本体评审员', 'REVIEWER');
  ins.run('viewer', bcrypt.hashSync('viewer123', 10), '只读访客', 'VIEWER');
}

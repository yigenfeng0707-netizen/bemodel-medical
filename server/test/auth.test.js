// 认证与权限矩阵测试（JWT 签发/篡改/过期 + login/me + authorize 角色矩阵）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import express from 'express';

process.env.LLM_API_KEY = '';
process.env.LLM_BACKUP_API_KEY = '';
process.env.EMBEDDING_TIMEOUT_MS = '1';

const dir = path.resolve('data-test', 'auth');
process.env.DATA_DIR = dir;

let app, server, platform, auth, ensureDatabases;
const tokens = {};

before(async () => {
  ({ platform, ensureDatabases } = await import('../src/db.js'));
  const { seedDemoDbs } = await import('../src/seed/demo.js');
  const { seedPlatformData } = await import('../src/seed/platform.js');
  auth = await import('../src/auth.js');
  const { seedUsers } = auth;

  await ensureDatabases();
  await platform.initSchema();

  assert.equal(await seedDemoDbs(true), true);
  await seedPlatformData(true);
  await seedUsers();
  for (const u of await platform.prepare('SELECT * FROM bm_user').all()) tokens[u.role] = auth.issueToken(u);

  app = express();
  app.use(express.json());
  app.use(auth.requireAuth);
  app.use(auth.authorize);
  app.use('/api/auth', auth.authRouter);
  // 探针路由：验证 authorize 矩阵（真实业务路由在各自模块测试里覆盖）
  const probe = (req, res) => res.json({ code: 0, data: req.auth?.role || 'anon' });
  app.get('/api/probe', probe);
  app.post('/api/probe', probe);
  app.put('/api/probe', probe);
  app.delete('/api/probe', probe);
  app.post('/api/probe/transition', probe);
  app.post('/api/cs/clarify/5/answer', probe);
  app.post('/api/rdf/validate/inline', probe);
  app.post('/healthz', probe);
  app.use((err, req, res, next) => { if (err) res.status(200).json({ code: 500, msg: err.message, data: null }); });

  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.on('listening', r));
});

after(() => server?.close());

async function call(method, url, body, token) {
  const port = server.address().port;
  const r = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

test('JWT: 签发与解析 round-trip', async () => {
  const u = await platform.prepare("SELECT * FROM bm_user WHERE username='admin'").get();
  const t = auth.issueToken(u);
  assert.equal(t.split('.').length, 3);
  const claims = auth.parseToken(t);
  assert.equal(claims.sub, 'admin');
  assert.equal(claims.role, 'ADMIN');
  assert.equal(claims.displayName, '平台管理员');
  assert.ok(claims.exp > claims.iat);
});

test('JWT: 篡改 payload / 签名 / 缺段 → 拒绝', () => {
  const t = tokens.ADMIN;
  const [h, p, s] = t.split('.');
  // 篡改 payload（换角色提权攻击）
  const forgedPayload = Buffer.from(JSON.stringify({ sub: 'admin', role: 'ADMIN', iat: 1, exp: Math.floor(Date.now() / 1000) + 99999 })).toString('base64url');
  assert.equal(auth.parseToken(`${h}.${forgedPayload}.${s}`), null);
  // 篡改签名
  assert.equal(auth.parseToken(`${h}.${p}.${s.slice(0, -2)}xx`), null);
  // 缺段
  assert.equal(auth.parseToken(`${h}.${p}`), null);
  assert.equal(auth.parseToken(''), null);
});

test('JWT: 过期 token → 拒绝', async () => {
  const { config } = await import('../src/config.js');
  const crypto = await import('node:crypto');
  const b64u = (buf) => Buffer.from(buf).toString('base64url');
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64u(JSON.stringify({ sub: 'admin', role: 'ADMIN', iat: 1, exp: 2 }));
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(`${header}.${payload}`).digest('base64url');
  assert.equal(auth.parseToken(`${header}.${payload}.${sig}`), null);
});

test('login: 正确密码 → token + 角色；错误密码 → 拒绝', async () => {
  const ok1 = await call('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  assert.equal(ok1.body.code, 0);
  assert.equal(ok1.body.data.role, 'ADMIN');
  assert.equal(ok1.body.data.token.split('.').length, 3);
  const ok2 = await call('POST', '/api/auth/login', { username: 'viewer', password: 'viewer123' });
  assert.equal(ok2.body.data.role, 'VIEWER');
  const bad = await call('POST', '/api/auth/login', { username: 'admin', password: 'wrong' });
  assert.ok(bad.body.msg.includes('用户名或密码错误'));
  const nouser = await call('POST', '/api/auth/login', { username: 'ghost', password: 'x' });
  assert.ok(nouser.body.msg.includes('用户名或密码错误'));
});

test('/me: 登录态返回用户信息，未登录 401', async () => {
  const me = await call('GET', '/api/auth/me', undefined, tokens.EDITOR);
  assert.equal(me.body.data.username, 'modeler');
  assert.equal(me.body.data.role, 'EDITOR');
  const anon = await call('GET', '/api/auth/me');
  assert.equal(anon.status, 401);
});

test('权限矩阵: GET /api/** 全角色放行', async () => {
  for (const role of ['ADMIN', 'EDITOR', 'REVIEWER', 'VIEWER']) {
    const r = await call('GET', '/api/probe', undefined, tokens[role]);
    assert.equal(r.body.data, role, role);
  }
  const anon = await call('GET', '/api/probe');
  assert.equal(anon.status, 401, '未登录 GET 仍需 401');
});

test('权限矩阵: 普通写操作 VIEWER/REVIEWER 403，EDITOR/ADMIN 放行', async () => {
  const v = await call('POST', '/api/probe', {}, tokens.VIEWER);
  assert.equal(v.status, 403);
  const e = await call('POST', '/api/probe', {}, tokens.EDITOR);
  assert.equal(e.body.data, 'EDITOR');
  const a = await call('POST', '/api/probe', {}, tokens.ADMIN);
  assert.equal(a.body.data, 'ADMIN');
  const vd = await call('DELETE', '/api/probe', undefined, tokens.VIEWER);
  assert.equal(vd.status, 403);
  const rv = await call('PUT', '/api/probe', {}, tokens.REVIEWER);
  assert.equal(rv.status, 403, 'REVIEWER 不能做普通写');
});

test('权限矩阵: transition 类 REVIEWER 放行，VIEWER 仍 403', async () => {
  const rv = await call('POST', '/api/probe/transition', {}, tokens.REVIEWER);
  assert.equal(rv.body.data, 'REVIEWER');
  const v = await call('POST', '/api/probe/transition', {}, tokens.VIEWER);
  assert.equal(v.status, 403);
  const e = await call('POST', '/api/probe/transition', {}, tokens.EDITOR);
  assert.equal(e.body.data, 'EDITOR');
});

test('权限矩阵: 只读型 POST openPosts 前缀全角色放行', async () => {
  const cv = await call('POST', '/api/cs/clarify/5/answer', { supplement: 'x' }, tokens.VIEWER);
  assert.equal(cv.body.data, 'VIEWER');
  const rv2 = await call('POST', '/api/rdf/validate/inline', {}, tokens.VIEWER);
  assert.equal(rv2.body.data, 'VIEWER');
});

test('权限矩阵: login / 非 /api 路径免认证放行', async () => {
  const login = await call('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  assert.equal(login.body.code, 0);
  const health = await call('POST', '/healthz', {});
  assert.equal(health.body.data, 'anon');
});

test('登录锁定: 同账号连续失败 5 次后临时锁定，正确密码也拒绝', async () => {
  for (let i = 0; i < 5; i++) {
    const bad = await call('POST', '/api/auth/login', { username: 'reviewer', password: 'wrong' });
    assert.ok(bad.body.msg.includes('用户名或密码错误'), `第 ${i + 1} 次失败应提示口令错误`);
  }
  const locked = await call('POST', '/api/auth/login', { username: 'reviewer', password: 'reviewer123' });
  assert.ok(locked.body.msg.includes('锁定'), '锁定后即使密码正确也应拒绝');
  assert.ok(!locked.body.data, '锁定时不应签发 token');
});

test('登录审计: 成功/失败/锁定均落 bm_login_audit', async () => {
  const okRow = await platform.prepare("SELECT * FROM bm_login_audit WHERE username='admin' AND result='SUCCESS'").all();
  assert.ok(okRow.length >= 1, '成功登录应留痕');
  assert.equal(okRow[0].success, 1);
  const badRow = await platform.prepare("SELECT * FROM bm_login_audit WHERE username='admin' AND result='BAD_CREDENTIALS'").all();
  assert.ok(badRow.length >= 1, '失败登录应留痕');
  const lockRow = await platform.prepare("SELECT * FROM bm_login_audit WHERE username='reviewer' AND result='LOCKED'").all();
  assert.ok(lockRow.length >= 1, '锁定期间尝试应留痕');
  assert.ok(okRow[0].ip, '审计应记录来源 IP');
});

test('logout: 登出后原 token 立即失效', async () => {
  const login = await call('POST', '/api/auth/login', { username: 'viewer', password: 'viewer123' });
  const token = login.body.data.token;
  const before1 = await call('GET', '/api/auth/me', undefined, token);
  assert.equal(before1.body.data.username, 'viewer');
  const out = await call('POST', '/api/auth/logout', {}, token);
  assert.equal(out.body.data.loggedOut, true);
  const after1 = await call('GET', '/api/auth/me', undefined, token);
  assert.equal(after1.status, 401, '登出后 /me 应 401');
  const again = await call('POST', '/api/auth/logout', {}, token);
  assert.equal(again.status, 401, '已吊销 token 不能再次登出');
  const fresh = await call('POST', '/api/auth/login', { username: 'viewer', password: 'viewer123' });
  const me2 = await call('GET', '/api/auth/me', undefined, fresh.body.data.token);
  assert.equal(me2.body.data.username, 'viewer', '重新登录应签发可用的新 token');
});

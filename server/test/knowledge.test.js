// 知识双轨集成测试（隔离 DATA_DIR；禁用 LLM/向量路；文档摄取/生命周期/防自审/条目审批/FTS5 检索）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import express from 'express';

process.env.LLM_API_KEY = '';
process.env.LLM_BACKUP_API_KEY = '';
process.env.EMBEDDING_BASE_URL = ''; // 关向量路，FTS5 关键词路 + 诚实降级
process.env.EMBEDDING_TIMEOUT_MS = '1'; // 配置层对空串回退默认 localhost:11434，1ms 超时保证测试不外呼等待

const dir = path.resolve('data-test', 'knowledge');
process.env.DATA_DIR = dir;

let app, server, adminToken, platform, ensureDatabases;

before(async () => {
  ({ platform, ensureDatabases } = await import('../src/db.js'));
  const { seedDemoDbs } = await import('../src/seed/demo.js');
  const { seedPlatformData } = await import('../src/seed/platform.js');
  const mod = await import('../src/knowledge.js');
  const { knowledgeRouter, parseDoc, knowledgeSearch, entryContent, basisEntries } = mod;
  Object.assign(globalThis, { knowledgeSearch, parseDoc, entryContent, basisEntries });
  const { requireAuth, authorize, issueToken, seedUsers } = await import('../src/auth.js');

  await ensureDatabases();
  await platform.initSchema();
  assert.equal(await seedDemoDbs(true), true);
  await seedPlatformData(true);
  await seedUsers();
  const admin = await platform.prepare("SELECT * FROM bm_user WHERE username='admin'").get();
  adminToken = issueToken(admin);

  app = express();
  app.use(express.json());
  app.use(requireAuth);
  app.use(authorize);
  app.use('/api/knowledge', knowledgeRouter);
  app.use((err, req, res, next) => { if (err) res.status(200).json({ code: 500, msg: err.message, data: null }); });

  server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.on('listening', r));
});

after(() => server?.close());

async function call(method, url, body) {
  const port = server.address().port;
  const r = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + adminToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

async function uploadMd(filename, content) {
  const fd = new FormData();
  fd.append('file', new Blob([content]), filename);
  const port = server.address().port;
  const r = await fetch(`http://127.0.0.1:${port}/api/knowledge/documents`, {
    method: 'POST', headers: { authorization: 'Bearer ' + adminToken }, body: fd,
  });
  return r.json();
}

test('parseDoc: md/txt 原生、非法类型/空内容拒收', () => {
  assert.equal(parseDoc('a.md', Buffer.from('# 标题\n正文')), '# 标题\n正文');
  assert.throws(() => parseDoc('a.exe', Buffer.from('x')), /仅支持/);
  assert.throws(() => parseDoc('empty.md', Buffer.from('   ')), /解析结果为空/);
});

test('文档摄取: 切分落表 + 内容去重 + 版本递增', async () => {
  const md = [
    '# 退费处理规范', '', '检验项目取消后必须当日退费。', '', '取消未退费属于资金裂缝，须当日清零。', '',
    '第二段落补充说明，处理流程为收费系统冲正并通知患者。',
  ].join('\n');
  const r1 = await uploadMd('退费处理规范.md', md);
  assert.equal(r1.code, 0);
  assert.ok(r1.data.chunks >= 1);
  globalThis.__doc1 = r1.data.id;
  const dup = await uploadMd('退费处理规范.md', md);
  assert.ok(dup.msg.includes('内容重复'));
  const r2 = await uploadMd('退费处理规范.md', md + '\n\n追加条款：五点前完成对账。'); // 同名换内容 → 版本化
  assert.equal(r2.code, 0);
  globalThis.__doc2 = r2.data.id;
  // chunk 落表且无向量（降级）
  const chunks = (await call('GET', `/api/knowledge/documents/${r1.data.id}/chunks`)).body.data;
  assert.ok(chunks.length === r1.data.chunks);
  assert.equal(chunks.every(c => c.has_embedding === 0), true);
});

test('revectorize: 向量路关闭时诚实返回 0 更新', async () => {
  const r = await call('POST', '/api/knowledge/documents/revectorize', {});
  assert.equal(r.body.data.updated, 0);
  assert.ok(r.body.data.remaining >= 1);
});

test('文档状态机: DRAFT→REVIEW→PUBLISHED，非法流转被拒', async () => {
  const id = globalThis.__doc1;
  const bad = await call('POST', `/api/knowledge/documents/${id}/transition`, { target: 'PUBLISHED' });
  assert.ok(bad.body.msg.includes('非法状态流转'));
  assert.equal((await call('POST', `/api/knowledge/documents/${id}/transition`, { target: 'REVIEW' })).body.code, 0);
  assert.equal((await call('POST', `/api/knowledge/documents/${id}/transition`, { target: 'PUBLISHED' })).body.code, 0);
  const del = await call('DELETE', `/api/knowledge/documents/${id}`);
  assert.ok(del.body.msg.includes('不可删除'));
});

test('同题新版发布 → 旧版自动 DEPRECATED', async () => {
  // 发布 v2 → 旧版自动弃用
  await call('POST', `/api/knowledge/documents/${globalThis.__doc2}/transition`, { target: 'REVIEW' });
  await call('POST', `/api/knowledge/documents/${globalThis.__doc2}/transition`, { target: 'PUBLISHED' });
  const docs = (await call('GET', '/api/knowledge/documents')).body.data;
  const same = docs.filter(d => d.title === '退费处理规范');
  const pub = same.filter(d => d.status === 'PUBLISHED');
  assert.equal(pub.length, 1, '同题只保留一个 PUBLISHED');
  assert.equal(pub[0].version, 2);
  assert.ok(someDeprecated(same), '旧版 DEPRECATED');
  function someDeprecated(arr) { return arr.some(d => d.status === 'DEPRECATED'); }
});

test('FTS5 检索: bigram 中文命中 + 仅 PUBLISHED 参与', async () => {
  const hits = await knowledgeSearch('取消未退费', 10);
  assert.ok(hits.length >= 1);
  const published = new Set((await call('GET', '/api/knowledge/documents')).body.data.filter(d => d.status === 'PUBLISHED').map(d => d.title));
  for (const h of hits) assert.ok(published.has(h.docTitle), '命中必须来自 PUBLISHED 文档: ' + h.docTitle);
  assert.ok(hits.some(h => h.docTitle === '退费处理规范' && h.content.includes('取消未退费')));
});

test('知识条目: 创建去重 + 改发布条目自动回 REVIEW + 发布递增版本', async () => {
  const mk = await call('POST', '/api/knowledge/entries', { code: 'KB-TEST-01', title: '测试条目', content: '口径说明', appliesTo: 'LAB_APPLY,DISPENSE' });
  assert.equal(mk.body.code, 0);
  const dup = await call('POST', '/api/knowledge/entries', { code: 'KB-TEST-01', title: 'x', content: 'y' });
  assert.ok(dup.body.msg.includes('已存在'));
  const miss = await call('POST', '/api/knowledge/entries', { code: 'KB-TEST-02' });
  assert.ok(miss.body.msg.includes('不能为空'));
  const list = (await call('GET', '/api/knowledge/entries')).body.data;
  const e = list.find(x => x.code === 'KB-TEST-01');
  assert.equal(e.status, 'DRAFT');
  // DRAFT→REVIEW→PUBLISHED（version+1）
  await call('POST', `/api/knowledge/entries/${e.id}/transition`, { target: 'REVIEW' });
  await call('POST', `/api/knowledge/entries/${e.id}/transition`, { target: 'PUBLISHED' });
  assert.equal(await entryContent('KB-TEST-01'), '口径说明');
  // 编辑已发布 → 自动回 REVIEW，读取口不再返回
  await call('PUT', `/api/knowledge/entries/${e.id}`, { content: '口径说明修订' });
  assert.equal(await entryContent('KB-TEST-01'), null, '改一条走审批');
  const e2 = await platform.prepare('SELECT * FROM bm_knowledge WHERE code=?').get('KB-TEST-01');
  assert.equal(e2.status, 'REVIEW');
  assert.equal(Number(e2.version), 2, '发布时 version 递增到 2');
});

test('basisEntries: applies_to CSV 命中概念，仅 PUBLISHED 参与读取', async () => {
  // KB-TEST-01 处于 REVIEW → 不参与
  let rows = await basisEntries('LAB_APPLY');
  assert.ok(rows.every(r => r.code !== 'KB-TEST-01'), '非 PUBLISHED 不进依据读取口');
  // 重新过审发布 → 参与且为修订内容
  const e = await platform.prepare("SELECT id FROM bm_knowledge WHERE code='KB-TEST-01'").get();
  await call('POST', `/api/knowledge/entries/${e.id}/transition`, { target: 'PUBLISHED' });
  rows = await basisEntries('LAB_APPLY');
  const hit = rows.find(r => r.code === 'KB-TEST-01');
  assert.ok(hit, '发布后进入读取口');
  assert.equal(hit.content, '口径说明修订');
});

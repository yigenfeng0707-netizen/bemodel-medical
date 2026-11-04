// 发布门禁集成测试（隔离 DATA_DIR；HTTP 层 + OWL 解析 + 闭包物化 + 版本递增）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const dir = path.resolve('data-test', 'release');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.DATA_DIR = dir;

let app, server, adminToken, viewerToken, seedPlatformData, checkOntology;

before(async () => {
  const { platform } = await import('../src/db.js');
  const { seedDemoDbs } = await import('../src/seed/demo.js');
  ({ seedPlatformData } = await import('../src/seed/platform.js'));
  ({ checkOntology } = await import('../src/ontology.js'));
  const { releaseRouter, owlRouter } = await import('../src/release.js');
  const { requireAuth, authorize, issueToken, seedUsers } = await import('../src/auth.js');
  const { BizException, ok } = await import('../src/common.js');

  assert.equal(seedDemoDbs(true), true);
  seedPlatformData();
  seedUsers();

  app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(requireAuth);
  app.use(authorize);
  app.use('/api/release', releaseRouter);
  app.use('/api/ontology', owlRouter);
  app.use((err, req, res, next) => {
    if (err) res.status(200).json({ code: 500, msg: err.message || 'err', data: null });
  });

  const users = platform.prepare('SELECT * FROM bm_user').all();
  adminToken = issueToken(users.find(u => u.username === 'admin'));
  viewerToken = issueToken(users.find(u => u.username === 'viewer'));

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

test('权限: VIEWER 发布被拒（authorize transition 矩阵）', async () => {
  const r = await call('POST', '/api/release/publish', { changeSummary: 'x' }, viewerToken);
  assert.equal(r.status, 403);
});

test('未登录发布被拒 401', async () => {
  const r = await call('POST', '/api/release/publish', {});
  assert.equal(r.status, 401);
});

test('发布: 种子本体可发布（BLOCKER=0，WARN 需 force）', async () => {
  const check = checkOntology();
  assert.equal(check.blockerCount, 0);
  const first = await call('POST', '/api/release/publish', { changeSummary: '首版' }, adminToken);
  if (check.defects.length > 0) {
    assert.equal(first.body.data.needForce, true);
    assert.ok(first.body.data.defects.length >= 1);
    const done = await call('POST', '/api/release/publish', { changeSummary: '首版', force: 'true' }, adminToken);
    assert.equal(done.body.code, 0);
    assert.equal(done.body.data.versionTag, 'v1.0');
  } else {
    assert.equal(first.body.data.versionTag, 'v1.0');
  }
  const cur = await call('GET', '/api/release/current', undefined, adminToken);
  assert.equal(cur.body.data.version, 'v1.0');
});

test('发布快照: 元素计数>0、闭包已物化、审批留痕', async () => {
  const { platform } = await import('../src/db.js');
  const rel = platform.prepare('SELECT * FROM bm_release ORDER BY id DESC LIMIT 1').get();
  assert.ok(rel.element_count > 0);
  assert.equal(rel.approved_by, 'admin');
  const snap = JSON.parse(rel.snapshot_json);
  assert.ok(snap.concepts.length >= 44);
  assert.ok(snap.relationClosures && Object.keys(snap.relationClosures).length >= 1);
  const closureRows = platform.prepare('SELECT COUNT(*) n FROM bm_relation_closure').get().n;
  assert.equal(closureRows, Object.values(snap.relationClosures).reduce((s, r) => s + r.derived, 0));
});

test('版本递增: 第二次发布 v1.1', async () => {
  const r = await call('POST', '/api/release/publish', { changeSummary: '二版', force: 'true' }, adminToken);
  assert.equal(r.body.data.versionTag, 'v1.1');
});

test('OWL Turtle 解析: Class/ObjectProperty/DatatypeProperty/未投影', async () => {
  // 解析器按「单行语句 + .\n 切分」且先剥 # 注释，故用斜杠式 IRI、属性同行分号连接
  const ttl = [
    '@prefix owl: <http://www.w3.org/2002/07/owl/> .',
    '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema/> .',
    '<http://ex.org/Inpatient> a owl:Class ; rdfs:label "住院就诊" ; rdfs:subClassOf <http://ex.org/PatientVisit> .',
    '<http://ex.org/hasFee> a owl:ObjectProperty, owl:TransitiveProperty ; rdfs:domain <http://ex.org/Inpatient> ; rdfs:range <http://ex.org/FeeDetail> .',
    '<http://ex.org/feeAmount> a owl:DatatypeProperty ; rdfs:domain <http://ex.org/FeeDetail> ; rdfs:range <http://ex.org/xsd/integer> .',
    '<http://ex.org/noDomainProp> a owl:DatatypeProperty ; rdfs:range <http://ex.org/xsd/string> .',
    '<http://ex.org/SomeRestriction> a owl:Restriction .',
  ].join('\n');
  const plan = await parseTtl(ttl);
  const classes = plan.items.filter(i => i.kind === 'CLASS');
  assert.equal(classes.length, 1);
  assert.equal(classes[0].name, '住院就诊');
  assert.deepEqual(classes[0].parents, ['PATIENT_VISIT']);
  const rels = plan.items.filter(i => i.kind === 'RELATION');
  assert.equal(rels.length, 1);
  assert.equal(rels[0].from, 'INPATIENT');
  assert.equal(rels[0].to, 'FEE_DETAIL');
  assert.equal(rels[0].trans, true);
  const attrs = plan.items.filter(i => i.kind === 'ATTRIBUTE');
  assert.equal(attrs.length, 1);
  assert.equal(attrs[0].dataType, 'NUMBER');
  assert.ok(plan.unprojected.length >= 2, '缺 domain + Restriction 均进未投影');
});

test('OWL RDF-XML 解析与执行导入: 概念/关系/属性落库', async () => {
  const xml = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:owl="http://www.w3.org/2002/07/owl#" xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#">
  <owl:Class rdf:about="http://ex.org#WardRound"><rdfs:label>查房</rdfs:label></owl:Class>
  <owl:Class rdf:about="http://ex.org#ClinicalEvent"><rdfs:label>临床事件</rdfs:label></owl:Class>
  <owl:ObjectProperty rdf:about="http://ex.org#duringRound">
    <rdfs:domain rdf:resource="http://ex.org#WardRound"/>
    <rdfs:range rdf:resource="http://ex.org#ClinicalEvent"/>
  </owl:ObjectProperty>
  <owl:DatatypeProperty rdf:about="http://ex.org#roundDate">
    <rdfs:domain rdf:resource="http://ex.org#WardRound"/>
    <rdfs:range rdf:resource="http://www.w3.org/2001/XMLSchema#date"/>
  </owl:DatatypeProperty>
</rdf:RDF>`;
  const preview = await call('POST', '/api/ontology/import/preview', { content: xml, filename: 'onto.rdf' }, adminToken);
  assert.equal(preview.body.code, 0);
  assert.equal(preview.body.data.items.filter(i => i.kind === 'CLASS').length, 2);
  const exec = await call('POST', '/api/ontology/import/execute', { content: xml, filename: 'onto.rdf' }, adminToken);
  const sum = exec.body.data.summary;
  assert.equal(sum.created, 4);
  const { platform } = await import('../src/db.js');
  assert.ok(platform.prepare("SELECT 1 FROM bm_domain WHERE code='IMPORT'").get());
  const c = platform.prepare("SELECT * FROM bm_concept WHERE code='WARD_ROUND'").get();
  assert.equal(c.name, '查房');
  assert.equal(c.iri, 'http://ex.org#WardRound');
  assert.ok(platform.prepare("SELECT 1 FROM bm_relation WHERE from_concept='WARD_ROUND' AND to_concept='CLINICAL_EVENT' AND relation_name='duringRound'").get());
  const a = platform.prepare("SELECT * FROM bm_attribute WHERE concept_code='WARD_ROUND' AND attr_code='ROUND_DATE'").get();
  assert.equal(a.data_type, 'DATE');
  // 幂等：重复导入变 UPDATE，不再 CREATE
  const again = await call('POST', '/api/ontology/import/execute', { content: xml, filename: 'onto.rdf' }, adminToken);
  assert.equal(again.body.data.summary.created, 0);
  assert.equal(again.body.data.summary.updated, 4);
});

// 辅助：在隔离上下文里调用 parseOwl（模块内导出，直接动态导入）
async function parseTtl(content) {
  const { parseOwl } = await import('../src/release.js');
  return parseOwl(content, 'x.ttl');
}

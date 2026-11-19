import express from 'express';
import { platform, now } from './db.js';
import { BizException, ok, checkTransition } from './common.js';
import { currentUser, hasAnyRole } from './auth.js';
import { chat, parseJsonLoose } from './llm.js';

export const ontologyRouter = express.Router();
const R = ontologyRouter;

// ======================= 业务域 =======================
R.get('/domain/list', async (req, res) => {
  res.json(ok(await platform.prepare('SELECT * FROM bm_domain ORDER BY sort, id').all()));
});
R.post('/domain', async (req, res) => {
  const { code, name, description, sort } = req.body || {};
  if (!code || !name) throw new BizException('编码与名称不能为空');
  if (await platform.prepare('SELECT 1 FROM bm_domain WHERE code=?').get(code)) throw new BizException('域编码已存在');
  await platform.prepare('INSERT INTO bm_domain(code,name,description,sort) VALUES (?,?,?,?)').run(code, name, description || '', sort || 0);
  res.json(ok(await platform.prepare('SELECT * FROM bm_domain WHERE code=?').get(code)));
});

// ======================= 概念 =======================
R.get('/concept/list', async (req, res) => {
  const { domainCode } = req.query;
  const rows = domainCode
    ? await platform.prepare('SELECT * FROM bm_concept WHERE domain_code=? ORDER BY code').all(domainCode)
    : await platform.prepare('SELECT * FROM bm_concept ORDER BY code').all();
  res.json(ok(rows));
});
R.get('/concept/detail/:code', async (req, res) => {
  const code = req.params.code;
  const concept = await platform.prepare('SELECT * FROM bm_concept WHERE code=?').get(code);
  if (!concept) throw new BizException('概念不存在');
  const attributes = await platform.prepare('SELECT * FROM bm_attribute WHERE concept_code=? ORDER BY sort, id').all(code);
  const relations = await platform.prepare('SELECT * FROM bm_relation WHERE from_concept=? OR to_concept=? ORDER BY id').all(code, code);
  const terms = await platform.prepare('SELECT * FROM bm_term WHERE concept_code=? ORDER BY id').all(code);
  const parents = await platform.prepare('SELECT p.*, c.name AS parent_name FROM bm_concept_parent p JOIN bm_concept c ON c.code=p.parent_code WHERE p.child_code=? ORDER BY p.is_primary DESC').all(code);
  const disjoint = await platform.prepare('SELECT * FROM bm_concept_disjoint WHERE concept_a_code=? OR concept_b_code=?').all(code, code);
  res.json(ok({ concept, attributes, relations, terms, parents, disjoint }));
});
R.post('/concept', async (req, res) => {
  const { code, name, domainCode, definition, owner, iri } = req.body || {};
  if (!code || !name || !domainCode) throw new BizException('编码/名称/所属域不能为空');
  if (!/^[A-Z][A-Z0-9_]*$/.test(code)) throw new BizException('概念编码须为大写字母开头的 A-Z0-9_');
  if (await platform.prepare('SELECT 1 FROM bm_concept WHERE code=?').get(code)) throw new BizException('概念编码已存在');
  if (!await platform.prepare('SELECT 1 FROM bm_domain WHERE code=?').get(domainCode)) throw new BizException('所属业务域不存在');
  if (iri && await platform.prepare('SELECT 1 FROM bm_concept WHERE iri=?').get(iri)) throw new BizException('IRI 已被其他概念占用');
  await platform.prepare('INSERT INTO bm_concept(code,name,domain_code,definition,owner,status,version,iri) VALUES (?,?,?,?,?,?,1,?)')
    .run(code, name, domainCode, definition || '', owner || null, 'DRAFT', iri || null);
  res.json(ok(await platform.prepare('SELECT * FROM bm_concept WHERE code=?').get(code)));
});
// 字段白名单更新：只允许 name/definition/iri/domainCode，防覆盖状态机字段
R.put('/concept', async (req, res) => {
  const { code } = req.body || {};
  const concept = await platform.prepare('SELECT * FROM bm_concept WHERE code=?').get(code);
  if (!concept) throw new BizException('概念不存在');
  const name = req.body.name !== undefined ? req.body.name : concept.name;
  const definition = req.body.definition !== undefined ? req.body.definition : concept.definition;
  let domainCode = req.body.domainCode !== undefined ? req.body.domainCode : concept.domain_code;
  if (domainCode && !await platform.prepare('SELECT 1 FROM bm_domain WHERE code=?').get(domainCode)) throw new BizException('所属业务域不存在');
  let iri = req.body.iri !== undefined ? (req.body.iri || null) : concept.iri;
  if (iri && await platform.prepare('SELECT 1 FROM bm_concept WHERE iri=? AND code<>?').get(iri, code)) throw new BizException('IRI 已被其他概念占用');
  await platform.prepare('UPDATE bm_concept SET name=?, definition=?, domain_code=?, iri=?, updated_at=? WHERE code=?')
    .run(name, definition, domainCode, iri, now(), code);
  res.json(ok(await platform.prepare('SELECT * FROM bm_concept WHERE code=?').get(code)));
});
R.delete('/concept/:code', async (req, res) => {
  const code = req.params.code;
  const concept = await platform.prepare('SELECT * FROM bm_concept WHERE code=?').get(code);
  if (!concept) throw new BizException('概念不存在');
  if (concept.status !== 'DRAFT') throw new BizException('仅草稿态概念可删除，已入库概念请走废弃流程');
  const cnt = async (sql, ...p) => (await platform.prepare(sql).get(...p)).c;
  const refs = {
    attributes: await cnt('SELECT COUNT(*) c FROM bm_attribute WHERE concept_code=?', code),
    relations: await cnt('SELECT COUNT(*) c FROM bm_relation WHERE from_concept=? OR to_concept=?', code, code),
    terms: await cnt('SELECT COUNT(*) c FROM bm_term WHERE concept_code=?', code),
    mappings: await cnt("SELECT COUNT(*) c FROM bm_mapping WHERE concept_code=? AND status='ACTIVE'", code),
    parents: await cnt('SELECT COUNT(*) c FROM bm_concept_parent WHERE child_code=? OR parent_code=?', code, code),
  };
  for (const [k, v] of Object.entries(refs)) if (v > 0) throw new BizException(`存在引用不可删除：${k} ${v} 条`);
  await platform.prepare('DELETE FROM bm_concept WHERE code=?').run(code);
  res.json(ok(true));
});

// 状态机（概念专用增强版；发布门禁在服务层二次校验）
R.post('/concept/transition/:code', async (req, res) => {
  const code = req.params.code;
  const target = req.query.target || req.body?.target;
  const concept = await platform.prepare('SELECT * FROM bm_concept WHERE code=?').get(code);
  if (!concept) throw new BizException('概念不存在');
  checkTransition(concept.status, target);
  const user = currentUser(req);
  if (target === 'PUBLISHED') {
    if (!hasAnyRole(req, 'REVIEWER', 'ADMIN')) throw new BizException('发布需评审员或管理员角色');
    if (user.role === 'REVIEWER' && concept.owner && concept.owner === (user.displayName || user.username)) {
      throw new BizException('评审员不得发布本人负责的概念（防自审）');
    }
  }
  if (target === 'DEPRECATED' && concept.status === 'PUBLISHED') {
    if (!hasAnyRole(req, 'REVIEWER', 'ADMIN')) throw new BizException('废弃已发布概念需评审员或管理员');
  }
  const version = target === 'PUBLISHED' ? concept.version + 1 : concept.version;
  await platform.prepare('UPDATE bm_concept SET status=?, version=?, updated_at=? WHERE code=?').run(target, version, now(), code);
  if (target === 'DEPRECATED' && concept.status === 'PUBLISHED') {
    await deprecatedConceptAlert(code, concept.name);
  }
  res.json(ok(await platform.prepare('SELECT * FROM bm_concept WHERE code=?').get(code)));
});

async function deprecatedConceptAlert(code, name) {
  const active = await platform.prepare("SELECT COUNT(*) c FROM bm_mapping WHERE concept_code=? AND status='ACTIVE'").get(code);
  if (!(active?.c)) return;
  const exist = await platform.prepare("SELECT id FROM bm_alert_notice WHERE metric_code=? AND status='未读'").get(`CONCEPT_DEPRECATED:${code}`);
  const msg = `概念「${name}」已废弃，仍有 ${active.c} 条生效映射引用；请评估停用映射或恢复概念`;
  if (exist) await platform.prepare('UPDATE bm_alert_notice SET message=?, created_at=? WHERE id=?').run(msg, now(), exist.id);
  else await platform.prepare('INSERT INTO bm_alert_notice(metric_code,metric_name,message) VALUES (?,?,?)').run(`CONCEPT_DEPRECATED:${code}`, `概念废弃联动`, msg);
}

// 属性
R.post('/concept/attribute', async (req, res) => {
  const { conceptCode, attrCode, attrName, dataType, isKey, definition } = req.body || {};
  if (!conceptCode || !attrCode || !attrName || !dataType) throw new BizException('概念/属性编码/属性名/类型不能为空');
  if (await platform.prepare('SELECT 1 FROM bm_attribute WHERE concept_code=? AND attr_code=?').get(conceptCode, attrCode)) throw new BizException('属性编码已存在');
  const sort = await platform.prepare('SELECT COALESCE(MAX(sort),0)+1 s FROM bm_attribute WHERE concept_code=?').get(conceptCode);
  await platform.prepare('INSERT INTO bm_attribute(concept_code,attr_code,attr_name,data_type,is_key,definition,sort) VALUES (?,?,?,?,?,?,?)')
    .run(conceptCode, attrCode, attrName, dataType, isKey ? 1 : 0, definition || '', sort?.s ?? 0);
  res.json(ok(await platform.prepare('SELECT * FROM bm_attribute WHERE concept_code=? AND attr_code=?').get(conceptCode, attrCode)));
});
R.delete('/concept/attribute/:id', async (req, res) => {
  await platform.prepare('DELETE FROM bm_attribute WHERE id=?').run(req.params.id);
  res.json(ok(true));
});

// 关系
async function relationPayload(b) {
  const { fromConcept, toConcept, relationName, description } = b || {};
  if (!fromConcept || !toConcept || !relationName) throw new BizException('两端概念与关系名不能为空');
  for (const c of [fromConcept, toConcept]) if (!await platform.prepare('SELECT 1 FROM bm_concept WHERE code=?').get(c)) throw new BizException(`概念 ${c} 不存在`);
  if (fromConcept === toConcept && relationName !== '同事' && !b.isSymmetric) { /* 允许自环但提示性校验放行 */ }
  return {
    from_concept: fromConcept, to_concept: toConcept, relation_name: relationName, description: description || '',
    is_symmetric: b.isSymmetric ? 1 : 0, is_transitive: b.isTransitive ? 1 : 0, is_functional: b.isFunctional ? 1 : 0,
    is_inverse_functional: b.isInverseFunctional ? 1 : 0, is_asymmetric: b.isAsymmetric ? 1 : 0,
    inverse_of: b.inverseOf || null, iri: b.iri || null,
  };
}
R.post('/concept/relation', async (req, res) => {
  const r = await relationPayload(req.body);
  if (await platform.prepare('SELECT 1 FROM bm_relation WHERE from_concept=? AND to_concept=? AND relation_name=?').get(r.from_concept, r.to_concept, r.relation_name)) {
    throw new BizException('关系已存在（同两端同关系名）');
  }
  if (r.iri && await platform.prepare('SELECT 1 FROM bm_relation WHERE iri=?').get(r.iri)) throw new BizException('IRI 已被占用');
  await platform.prepare(`INSERT INTO bm_relation(from_concept,to_concept,relation_name,description,is_symmetric,is_transitive,is_functional,is_inverse_functional,is_asymmetric,inverse_of,iri)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(r.from_concept, r.to_concept, r.relation_name, r.description, r.is_symmetric, r.is_transitive, r.is_functional, r.is_inverse_functional, r.is_asymmetric, r.inverse_of, r.iri);
  res.json(ok(await platform.prepare('SELECT * FROM bm_relation WHERE from_concept=? AND to_concept=? AND relation_name=?').get(r.from_concept, r.to_concept, r.relation_name)));
});
R.put('/concept/relation/:id', async (req, res) => {
  const old = await platform.prepare('SELECT * FROM bm_relation WHERE id=?').get(req.params.id);
  if (!old) throw new BizException('关系不存在');
  const b = { ...req.body, fromConcept: old.from_concept, toConcept: old.to_concept, relationName: old.relation_name };
  const r = await relationPayload(b);
  await platform.prepare(`UPDATE bm_relation SET description=?, is_symmetric=?, is_transitive=?, is_functional=?, is_inverse_functional=?, is_asymmetric=?, inverse_of=?, iri=? WHERE id=?`)
    .run(r.description, r.is_symmetric, r.is_transitive, r.is_functional, r.is_inverse_functional, r.is_asymmetric, r.inverse_of, r.iri, req.params.id);
  res.json(ok(await platform.prepare('SELECT * FROM bm_relation WHERE id=?').get(req.params.id)));
});
R.delete('/concept/relation/:id', async (req, res) => {
  await platform.prepare('DELETE FROM bm_relation WHERE id=?').run(req.params.id);
  res.json(ok(true));
});

// ======================= 多父继承 =======================
async function ancestorsOf(code) {
  const visited = new Set();
  const queue = [code];
  while (queue.length) {
    const cur = queue.shift();
    for (const r of await platform.prepare('SELECT parent_code FROM bm_concept_parent WHERE child_code=?').all(cur)) {
      if (!visited.has(r.parent_code)) { visited.add(r.parent_code); queue.push(r.parent_code); }
    }
  }
  visited.delete(code);
  return [...visited];
}
R.get('/concept/:code/parents', async (req, res) => {
  res.json(ok(await platform.prepare('SELECT p.*, c.name AS parent_name FROM bm_concept_parent p JOIN bm_concept c ON c.code=p.parent_code WHERE p.child_code=?').all(req.params.code)));
});
R.post('/concept/:code/parents', async (req, res) => {
  const child = req.params.code, parentCode = req.body.parentCode, isPrimary = !!req.body.isPrimary;
  if (!await platform.prepare('SELECT 1 FROM bm_concept WHERE code=?').get(child)) throw new BizException('子概念不存在');
  if (!await platform.prepare('SELECT 1 FROM bm_concept WHERE code=?').get(parentCode)) throw new BizException('父概念不存在');
  if (child === parentCode) throw new BizException('不能自继承');
  if (await platform.prepare('SELECT 1 FROM bm_concept_parent WHERE child_code=? AND parent_code=?').get(child, parentCode)) throw new BizException('继承边已存在');
  if ((await ancestorsOf(parentCode)).includes(child)) throw new BizException('存在继承环：该父概念已是当前概念的后代');
  if (isPrimary) await platform.prepare('UPDATE bm_concept_parent SET is_primary=0 WHERE child_code=?').run(child);
  await platform.prepare('INSERT INTO bm_concept_parent(child_code,parent_code,is_primary) VALUES (?,?,?)').run(child, parentCode, isPrimary ? 1 : 0);
  res.json(ok(true));
});
R.delete('/concept/:code/parents/:parentCode', async (req, res) => {
  await platform.prepare('DELETE FROM bm_concept_parent WHERE child_code=? AND parent_code=?').run(req.params.code, req.params.parentCode);
  res.json(ok(true));
});
R.put('/concept/:code/parents/:parentCode/primary', async (req, res) => {
  await platform.prepare('UPDATE bm_concept_parent SET is_primary=0 WHERE child_code=?').run(req.params.code);
  await platform.prepare('UPDATE bm_concept_parent SET is_primary=1 WHERE child_code=? AND parent_code=?').run(req.params.code, req.params.parentCode);
  res.json(ok(true));
});

// ======================= 互斥 / 公理 / 术语 =======================
R.get('/ontology/disjoint', async (req, res) => {
  res.json(ok(await platform.prepare('SELECT * FROM bm_concept_disjoint ORDER BY id').all()));
});
R.post('/ontology/disjoint', async (req, res) => {
  let { conceptACode, conceptBCode, definition } = req.body || {};
  if (!conceptACode || !conceptBCode) throw new BizException('两端概念不能为空');
  if (conceptACode === conceptBCode) throw new BizException('概念不能与自身互斥');
  for (const c of [conceptACode, conceptBCode]) if (!await platform.prepare('SELECT 1 FROM bm_concept WHERE code=?').get(c)) throw new BizException(`概念 ${c} 不存在`);
  if (await platform.prepare('SELECT 1 FROM bm_concept_disjoint WHERE (concept_a_code=? AND concept_b_code=?) OR (concept_a_code=? AND concept_b_code=?)').get(conceptACode, conceptBCode, conceptBCode, conceptACode)) {
    throw new BizException('互斥公理已存在');
  }
  if (conceptACode > conceptBCode) [conceptACode, conceptBCode] = [conceptBCode, conceptACode]; // 字典序规范化
  await platform.prepare('INSERT INTO bm_concept_disjoint(concept_a_code,concept_b_code,definition) VALUES (?,?,?)').run(conceptACode, conceptBCode, definition || '');
  res.json(ok(true));
});
R.delete('/ontology/disjoint/:id', async (req, res) => {
  await platform.prepare('DELETE FROM bm_concept_disjoint WHERE id=?').run(req.params.id);
  res.json(ok(true));
});

R.get('/axiom/list', async (req, res) => {
  res.json(ok(await platform.prepare('SELECT * FROM bm_axiom ORDER BY id').all()));
});
R.post('/axiom', async (req, res) => {
  const { subject, predicate, object, axiomType, description } = req.body || {};
  if (!subject || !predicate || !object || !axiomType) throw new BizException('主语/谓词/宾语/类型不能为空');
  const code = `AX-C${Date.now().toString(36).toUpperCase()}`;
  await platform.prepare('INSERT INTO bm_axiom(axiom_code,subject,predicate,object,axiom_type,description) VALUES (?,?,?,?,?,?)')
    .run(code, subject, predicate, object, axiomType, description || '');
  res.json(ok(await platform.prepare('SELECT * FROM bm_axiom WHERE axiom_code=?').get(code)));
});
R.delete('/axiom/:id', async (req, res) => {
  await platform.prepare('DELETE FROM bm_axiom WHERE id=?').run(req.params.id);
  res.json(ok(true));
});

// ======================= 术语 =======================
R.get('/term/list', async (req, res) => {
  const { conceptCode } = req.query;
  const rows = conceptCode
    ? await platform.prepare('SELECT * FROM bm_term WHERE concept_code=? ORDER BY id').all(conceptCode)
    : await platform.prepare('SELECT * FROM bm_term ORDER BY id').all();
  res.json(ok(rows));
});
R.post('/term', async (req, res) => {
  const { term, conceptCode, sourceProduct, termType } = req.body || {};
  if (!term || !conceptCode) throw new BizException('术语与概念不能为空');
  if (!await platform.prepare('SELECT 1 FROM bm_concept WHERE code=?').get(conceptCode)) throw new BizException('概念不存在');
  const sp = sourceProduct || '平台标准';
  if (await platform.prepare('SELECT 1 FROM bm_term WHERE term=? AND source_product=?').get(term, sp)) throw new BizException('同来源下术语已存在');
  await platform.prepare('INSERT INTO bm_term(term,concept_code,source_product,term_type) VALUES (?,?,?,?)').run(term, conceptCode, sp, termType || 'ALIAS');
  res.json(ok(true));
});
R.delete('/term/:id', async (req, res) => {
  await platform.prepare('DELETE FROM bm_term WHERE id=?').run(req.params.id);
  res.json(ok(true));
});

// ======================= 规则 / 动作 =======================
R.get('/rule/list', async (req, res) => {
  const { conceptCode } = req.query;
  const rows = conceptCode
    ? await platform.prepare('SELECT * FROM bm_rule WHERE concept_code=? ORDER BY rule_code').all(conceptCode)
    : await platform.prepare('SELECT * FROM bm_rule ORDER BY rule_code').all();
  res.json(ok(rows));
});
R.post('/rule', async (req, res) => {
  const b = req.body || {};
  if (!b.ruleCode || !b.name || !b.conceptCode || !b.expression) throw new BizException('编码/名称/概念/表达式不能为空');
  if (await platform.prepare('SELECT 1 FROM bm_rule WHERE rule_code=?').get(b.ruleCode)) throw new BizException('规则编码已存在');
  await platform.prepare('INSERT INTO bm_rule(rule_code,name,concept_code,rule_type,expression,metric_code,severity,owner,status,version,engine,expr_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(b.ruleCode, b.name, b.conceptCode, b.ruleType || '校验', b.expression, b.metricCode || null, b.severity || '中', b.owner || null, b.status || 'DRAFT', 1, b.engine || null, b.exprJson || null);
  res.json(ok(await platform.prepare('SELECT * FROM bm_rule WHERE rule_code=?').get(b.ruleCode)));
});
R.put('/rule/:id', async (req, res) => {
  const old = await platform.prepare('SELECT * FROM bm_rule WHERE id=?').get(req.params.id);
  if (!old) throw new BizException('规则不存在');
  await platform.prepare('UPDATE bm_rule SET name=?, rule_type=?, expression=?, metric_code=?, severity=?, owner=?, engine=?, expr_json=?, updated_at=? WHERE id=?')
    .run(req.body.name ?? old.name, req.body.ruleType ?? old.rule_type, req.body.expression ?? old.expression, req.body.metricCode ?? old.metric_code,
      req.body.severity ?? old.severity, req.body.owner ?? old.owner, req.body.engine ?? old.engine, req.body.exprJson ?? old.expr_json, now(), req.params.id);
  res.json(ok(await platform.prepare('SELECT * FROM bm_rule WHERE id=?').get(req.params.id)));
});
R.post('/rule/transition/:ruleCode', async (req, res) => {
  const rule = await platform.prepare('SELECT * FROM bm_rule WHERE rule_code=?').get(req.params.ruleCode);
  if (!rule) throw new BizException('规则不存在');
  const target = req.query.target || req.body?.target;
  checkTransition(rule.status, target);
  if (target === 'PUBLISHED' && !hasAnyRole(req, 'REVIEWER', 'ADMIN')) throw new BizException('发布需评审员或管理员角色');
  await platform.prepare('UPDATE bm_rule SET status=?, version=version+?, updated_at=? WHERE id=?').run(target, target === 'PUBLISHED' ? 1 : 0, now(), rule.id);
  res.json(ok(await platform.prepare('SELECT * FROM bm_rule WHERE id=?').get(rule.id)));
});
R.delete('/rule/:id', async (req, res) => {
  await platform.prepare('DELETE FROM bm_rule WHERE id=?').run(req.params.id);
  res.json(ok(true));
});

R.get('/action/list', async (req, res) => {
  res.json(ok(await platform.prepare('SELECT * FROM bm_action ORDER BY action_code').all()));
});
R.post('/action', async (req, res) => {
  const b = req.body || {};
  if (!b.actionCode || !b.name || !b.conceptCode || !b.toStatus) throw new BizException('编码/名称/概念/目标状态不能为空');
  if (await platform.prepare('SELECT 1 FROM bm_action WHERE action_code=?').get(b.actionCode)) throw new BizException('动作编码已存在');
  await platform.prepare('INSERT INTO bm_action(action_code,name,concept_code,from_status,to_status,trigger_desc,description,status,version) VALUES (?,?,?,?,?,?,?,?,1)')
    .run(b.actionCode, b.name, b.conceptCode, b.fromStatus || null, b.toStatus, b.triggerDesc || '', b.description || '', b.status || 'DRAFT');
  res.json(ok(true));
});
R.put('/action/:id', async (req, res) => {
  const old = await platform.prepare('SELECT * FROM bm_action WHERE id=?').get(req.params.id);
  if (!old) throw new BizException('动作不存在');
  await platform.prepare('UPDATE bm_action SET name=?, from_status=?, to_status=?, trigger_desc=?, description=?, updated_at=? WHERE id=?')
    .run(req.body.name ?? old.name, req.body.fromStatus ?? old.from_status, req.body.toStatus ?? old.to_status,
      req.body.triggerDesc ?? old.trigger_desc, req.body.description ?? old.description, now(), req.params.id);
  res.json(ok(true));
});
R.post('/action/transition/:actionCode', async (req, res) => {
  const a = await platform.prepare('SELECT * FROM bm_action WHERE action_code=?').get(req.params.actionCode);
  if (!a) throw new BizException('动作不存在');
  const target = req.query.target || req.body?.target;
  checkTransition(a.status, target);
  if (target === 'PUBLISHED' && !hasAnyRole(req, 'REVIEWER', 'ADMIN')) throw new BizException('发布需评审员或管理员角色');
  await platform.prepare('UPDATE bm_action SET status=?, version=version+?, updated_at=? WHERE id=?').run(target, target === 'PUBLISHED' ? 1 : 0, now(), a.id);
  res.json(ok(true));
});
R.delete('/action/:id', async (req, res) => {
  await platform.prepare('DELETE FROM bm_action WHERE id=?').run(req.params.id);
  res.json(ok(true));
});

// ======================= 本体自检（发布门禁复用） =======================
export async function checkOntology() {
  const defects = [];
  const add = (type, severity, message, refs) => defects.push({ type, severity, message, refs: refs || [] });
  const relations = await platform.prepare('SELECT * FROM bm_relation').all();
  const disjoints = await platform.prepare('SELECT * FROM bm_concept_disjoint').all();
  const parents = await platform.prepare('SELECT * FROM bm_concept_parent').all();

  // 1 对称+反对称 BLOCKER / 2 传递+函数 WARN
  for (const r of relations) {
    if (r.is_symmetric && r.is_asymmetric) add('SYMMETRIC_ASYMMETRIC', 'BLOCKER', `关系「${r.relation_name}」同时为对称与反对称`, [`${r.from_concept}→${r.to_concept}`]);
    if (r.is_transitive && r.is_functional) add('TRANSITIVE_FUNCTIONAL', 'WARN', `关系「${r.relation_name}」同时为传递与函数（闭包与唯一值语义冲突）`, [`${r.from_concept}→${r.to_concept}`]);
  }
  // 3/4 互逆
  for (const r of relations) {
    if (r.inverse_of === r.relation_name) add('INVERSE_SELF', 'BLOCKER', `关系「${r.relation_name}」的互逆指向自身`, [`${r.from_concept}→${r.to_concept}`]);
    if (r.inverse_of) {
      const inv = await platform.prepare('SELECT * FROM bm_relation WHERE relation_name=?').get(r.inverse_of);
      if (!inv) add('INVERSE_NOT_MUTUAL', 'WARN', `关系「${r.relation_name}」声明的互逆关系「${r.inverse_of}」不存在`, [`${r.from_concept}→${r.to_concept}`]);
      else if (inv.inverse_of !== r.relation_name) add('INVERSE_NOT_MUTUAL', 'WARN', `互逆未成对：「${r.relation_name}」⇄「${r.inverse_of}」`, [`${r.from_concept}→${r.to_concept}`]);
    }
  }
  // 5/6 互斥
  for (const d of disjoints) {
    if (d.concept_a_code === d.concept_b_code) add('DISJOINT_SELF', 'BLOCKER', `互斥公理两端为同一概念 ${d.concept_a_code}`, [d.concept_a_code]);
    else {
      // 逐概念串行查询（async filter 不可用）
      const missArr = [];
      for (const c of [d.concept_a_code, d.concept_b_code]) {
        if (!await platform.prepare('SELECT 1 FROM bm_concept WHERE code=?').get(c)) missArr.push(c);
      }
      if (missArr.length) add('DISJOINT_DANGLING', 'WARN', `互斥公理引用不存在的概念：${missArr.join(',')}`, missArr);
    }
  }
  // 7 继承环（三色 DFS）
  const color = new Map();
  const stack = [];
  const cycles = new Set();
  const dfs = (node) => {
    color.set(node, 1); stack.push(node);
    for (const e of parents.filter(p => p.child_code === node)) {
      const c = color.get(e.parent_code) || 0;
      if (c === 1) {
        const at = stack.indexOf(e.parent_code);
        const ring = stack.slice(at).concat([e.parent_code]);
        const min = ring.slice().sort()[0];
        const atMin = ring.indexOf(min);
        const normalized = ring.slice(atMin).concat(ring.slice(0, atMin));
        cycles.add(normalized.join('→'));
      } else if (c === 0) dfs(e.parent_code);
    }
    color.set(node, 2); stack.pop();
  };
  for (const p of parents) if (!color.get(p.child_code)) dfs(p.child_code);
  for (const c of cycles) add('SUBCLASS_CYCLE', 'BLOCKER', `继承关系存在环：${c}`, c.split('→'));
  // 8 IRI 重复
  const iriGroups = {};
  for (const c of await platform.prepare('SELECT code, iri FROM bm_concept WHERE iri IS NOT NULL').all()) {
    (iriGroups[c.iri] = iriGroups[c.iri] || []).push(c.code);
  }
  for (const [iri, codes] of Object.entries(iriGroups)) {
    if (codes.length > 1) add('IRI_DUPLICATE', 'BLOCKER', `多个概念共用 IRI ${iri}`, codes.sort());
  }
  // 9 已发布概念无属性
  for (const c of await platform.prepare("SELECT code, name FROM bm_concept WHERE status='PUBLISHED'").all()) {
    const n = await platform.prepare('SELECT COUNT(*) c FROM bm_attribute WHERE concept_code=?').get(c.code);
    if ((n?.c ?? 0) === 0) add('CONCEPT_NO_ATTR', 'WARN', `已发布概念「${c.name}」无任何属性（裸概念）`, [c.code]);
  }
  // 10 属性映射覆盖
  for (const c of await platform.prepare("SELECT code, name FROM bm_concept WHERE status='PUBLISHED'").all()) {
    const attrs = (await platform.prepare('SELECT attr_code FROM bm_attribute WHERE concept_code=?').all(c.code)).map(a => a.attr_code);
    if (!attrs.length) continue;
    const mapped = new Set((await platform.prepare("SELECT attr_code FROM bm_mapping WHERE concept_code=? AND status='ACTIVE'").all(c.code)).map(m => m.attr_code));
    const missing = attrs.filter(a => !mapped.has(a));
    if (missing.length) add('ATTR_MAPPING_COVERAGE', 'WARN', `概念「${c.name}」存在 ${missing.length} 个属性缺少生效映射`, [c.code, ...missing.slice(0, 8)]);
  }
  defects.sort((a, b) => a.type.localeCompare(b.type) || JSON.stringify(a.refs).localeCompare(JSON.stringify(b.refs)));
  return {
    defects,
    blockerCount: defects.filter(d => d.severity === 'BLOCKER').length,
    warnCount: defects.filter(d => d.severity === 'WARN').length,
  };
}
R.post('/ontology/check', async (req, res) => {
  res.json(ok(await checkOntology()));
});

// 传递闭包查询
R.get('/ontology/relation/closure', async (req, res) => {
  const { relation, concept } = req.query;
  let rows;
  if (relation && concept) rows = await platform.prepare('SELECT * FROM bm_relation_closure WHERE relation_name=? AND from_concept=? ORDER BY depth').all(relation, concept);
  else if (relation) rows = await platform.prepare('SELECT * FROM bm_relation_closure WHERE relation_name=? ORDER BY from_concept, depth').all(relation);
  else rows = await platform.prepare('SELECT * FROM bm_relation_closure ORDER BY relation_name, from_concept, depth').all();
  res.json(ok(rows));
});

// ======================= 概念缺口（miss 池） =======================
export async function recordMiss(term, kind, source) {
  try {
    const t = String(term || '').trim();
    if (t.length < 2 || t.length > 128) return null;
    await platform.prepare(`INSERT INTO bm_ontology_miss(term,kind,source,count) VALUES (?,?,?,1)
      ON CONFLICT(term,kind) DO UPDATE SET count=count+1, last_seen=?`).run(t, kind, source, now());
    return await platform.prepare('SELECT * FROM bm_ontology_miss WHERE term=? AND kind=?').get(t, kind);
  } catch { return null; }
}
export async function pendingMissCount() {
  return (await platform.prepare('SELECT COUNT(*) c FROM bm_ontology_miss WHERE dismissed=0 AND revoked=0 AND (adopted_concept_code IS NULL OR revoked=1)').get()).c;
}
R.get('/ontology/misses', async (req, res) => {
  const rows = await platform.prepare('SELECT * FROM bm_ontology_miss ORDER BY dismissed, revoked, count DESC, id DESC').all();
  res.json(ok({ list: rows, pendingCount: await pendingMissCount() }));
});
R.post('/ontology/misses/:id/dismiss', async (req, res) => {
  await platform.prepare('UPDATE bm_ontology_miss SET dismissed=1, dismiss_reason=? WHERE id=?').run(req.body?.reason || '', req.params.id);
  res.json(ok(true));
});
R.post('/ontology/misses/:id/undismiss', async (req, res) => {
  await platform.prepare('UPDATE bm_ontology_miss SET dismissed=0, dismiss_reason=NULL WHERE id=?').run(req.params.id);
  res.json(ok(true));
});
R.post('/ontology/misses/:id/adopt', async (req, res) => {
  const miss = await platform.prepare('SELECT * FROM bm_ontology_miss WHERE id=?').get(req.params.id);
  if (!miss) throw new BizException('缺口不存在');
  if (miss.adopted_concept_code && !miss.revoked) throw new BizException('该缺口已采纳，如需调整请先撤销');
  const { code, name, domainCode, definition } = req.body || {};
  if (!code || !name || !domainCode) throw new BizException('编码/名称/域不能为空');
  if (await platform.prepare('SELECT 1 FROM bm_concept WHERE code=?').get(code)) throw new BizException('概念编码已存在');
  await platform.prepare('INSERT INTO bm_concept(code,name,domain_code,definition,owner,status,version) VALUES (?,?,?,?,?,?,1)')
    .run(code, name, domainCode, definition || '', '本体增长回路', 'DRAFT');
  await platform.prepare('UPDATE bm_ontology_miss SET adopted_concept_code=?, adopted_as=?, revoked=0 WHERE id=?').run(code, 'CONCEPT', req.params.id);
  res.json(ok(true));
});
R.post('/ontology/misses/:id/adopt-as-term', async (req, res) => {
  const miss = await platform.prepare('SELECT * FROM bm_ontology_miss WHERE id=?').get(req.params.id);
  if (!miss) throw new BizException('缺口不存在');
  const { conceptCode } = req.body || {};
  if (!conceptCode || !await platform.prepare('SELECT 1 FROM bm_concept WHERE code=?').get(conceptCode)) throw new BizException('挂靠概念不存在');
  const exist = await platform.prepare('SELECT * FROM bm_term WHERE term=? AND source_product=?').get(miss.term, 'ONTOLOGY_MISS');
  if (exist) await platform.prepare('UPDATE bm_term SET concept_code=? WHERE id=?').run(conceptCode, exist.id);
  else await platform.prepare('INSERT INTO bm_term(term,concept_code,source_product,term_type,code_system) VALUES (?,?,?,?,?)').run(miss.term, conceptCode, 'ONTOLOGY_MISS', 'ALIAS', '平台标准');
  await platform.prepare('UPDATE bm_ontology_miss SET adopted_concept_code=?, adopted_as=?, revoked=0 WHERE id=?').run(conceptCode, 'TERM', req.params.id);
  res.json(ok(true));
});
R.post('/ontology/misses/:id/revoke', async (req, res) => {
  const miss = await platform.prepare('SELECT * FROM bm_ontology_miss WHERE id=?').get(req.params.id);
  if (!miss) throw new BizException('缺口不存在');
  if (miss.adopted_as === 'TERM' && !miss.revoked) {
    await platform.prepare("DELETE FROM bm_term WHERE term=? AND source_product='ONTOLOGY_MISS' AND concept_code=?").run(miss.term, miss.adopted_concept_code);
  } else if (miss.adopted_as === 'CONCEPT' && !miss.revoked) {
    const others = await platform.prepare("SELECT COUNT(*) c FROM bm_ontology_miss WHERE adopted_concept_code=? AND adopted_as='CONCEPT' AND id<>? AND revoked=0").get(miss.adopted_concept_code, miss.id);
    if ((others?.c ?? 0) === 0) {
      const c = await platform.prepare('SELECT * FROM bm_concept WHERE code=?').get(miss.adopted_concept_code);
      if (c && c.status === 'DRAFT') await platform.prepare("UPDATE bm_concept SET status='DEPRECATED' WHERE code=?").run(c.code);
    }
  }
  await platform.prepare('UPDATE bm_ontology_miss SET revoked=1 WHERE id=?').run(req.params.id);
  res.json(ok(true));
});
R.post('/ontology/misses/:id/classify', async (req, res) => {
  const miss = await platform.prepare('SELECT * FROM bm_ontology_miss WHERE id=?').get(req.params.id);
  if (!miss) throw new BizException('缺口不存在');
  const domains = await platform.prepare('SELECT code, name FROM bm_domain ORDER BY sort').all();
  const concepts = await platform.prepare('SELECT code, name, domain_code FROM bm_concept ORDER BY domain_code').all();
  let suggestion = null, degraded = false;
  const llm = await chat('MISS_CLASSIFY',
    '你是医疗信息化本体专家。根据词表外说法，建议标准概念归类。只返回 JSON，不要多余文字。',
    `词表外说法：「${miss.term}」（类型：${miss.kind}）\n\n现有业务域：${domains.map(d => `${d.code}(${d.name})`).join('、')}\n\n现有概念：${concepts.map(c => `${c.code}(${c.name})`).join('、')}\n\n判断：若是新概念，返回 {"action":"NEW_CONCEPT","code":"大写蛇形编码","name":"...","domainCode":"...","definition":"...","reason":"...","confidence":0.8}；若应挂靠为现有概念的别名，返回 {"action":"ATTACH_TERM","targetConceptCode":"...","reason":"...","confidence":0.8}`);
  const parsed = parseJsonLoose(llm);
  if (parsed && (parsed.action === 'NEW_CONCEPT' || parsed.action === 'ATTACH_TERM')) {
    suggestion = parsed;
    if (parsed.action === 'NEW_CONCEPT') {
      if (await platform.prepare('SELECT 1 FROM bm_concept WHERE code=?').get(parsed.code)) suggestion.codeTaken = true;
      if (!domains.some(d => d.code === parsed.domainCode)) { suggestion.domainCode = ''; suggestion.domainValid = false; }
    } else if (!await platform.prepare('SELECT 1 FROM bm_concept WHERE code=?').get(parsed.targetConceptCode)) {
      suggestion.targetConceptCode = '';
    }
  } else {
    degraded = true;
    const snake = miss.term.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
    suggestion = {
      action: 'NEW_CONCEPT', code: snake && !await platform.prepare('SELECT 1 FROM bm_concept WHERE code=?').get(snake) ? snake : `MISS_${miss.id}`,
      name: miss.term, domainCode: 'CLINICAL', definition: `（规则降级建议）来自「${miss.source}」的说法「${miss.term}」`,
      reason: 'LLM 不可用，按规则生成兜底建议，请人工修正', confidence: 0.4,
    };
  }
  res.json(ok({ missId: miss.id, suggestion, degraded }));
});

// ======================= AI 提案队列（L2） =======================
R.get('/proposal/list', async (req, res) => {
  const { status } = req.query;
  const rows = status && status !== 'ALL'
    ? await platform.prepare('SELECT * FROM bm_ontology_proposal WHERE status=? ORDER BY CASE status WHEN ? THEN 0 ELSE 1 END, decided_at DESC, id DESC').all(status, status)
    : await platform.prepare("SELECT * FROM bm_ontology_proposal ORDER BY CASE status WHEN 'PENDING' THEN 0 ELSE 1 END, decided_at DESC, id DESC").all();
  res.json(ok(rows));
});
let proposalRunning = false;
R.post('/proposal/run', async (req, res) => {
  if (proposalRunning) throw new BizException('提案生成进行中，请稍候');
  proposalRunning = true;
  try {
    const topN = parseInt(req.body?.topN || '10', 10);
    // PG：jsonb_array_elements_text 替代 SQLite json_each，取 miss_ids 数组元素作为待排除 id
    const candidates = await platform.prepare(`SELECT m.* FROM bm_ontology_miss m
      WHERE m.kind='CONCEPT' AND m.dismissed=0 AND m.revoked=0 AND (m.adopted_concept_code IS NULL OR m.revoked=1)
      AND m.id NOT IN (SELECT (je::text)::int FROM bm_ontology_proposal p, jsonb_array_elements_text(p.miss_ids::jsonb) je WHERE p.status='PENDING')
      ORDER BY m.count DESC, m.id ASC LIMIT ?`).all(topN);
    let generated = 0, llmFailed = 0;
    const groups = new Map();
    for (const miss of candidates) {
      const card = await suggestProposal(miss);
      if (!card) { llmFailed++; continue; }
      const key = `${card.action}:${card.action === 'NEW_CONCEPT' ? card.code : card.targetConceptCode}`;
      const g = groups.get(key) || { ...card, missIds: [], signalCount: 0, warnings: [] };
      g.missIds.push(miss.id);
      g.signalCount += miss.count;
      if (g.missIds.length > 1 && !g.warnings.includes(`已归并 ${g.missIds.length} 条同信号缺口`)) g.warnings.push(`已归并 ${g.missIds.length} 条同信号缺口`);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      const run = await platform.prepare('INSERT INTO bm_proposal_run(scanned,generated_cnt,llm_failed,message) VALUES (?,?,?,?)')
        .run(candidates.length, groups.size, llmFailed, null);
      await platform.prepare(`INSERT INTO bm_ontology_proposal(primary_miss_id,miss_ids,term,signal_count,action,target_concept_code,suggestion_json,status,run_id)
        VALUES (?,?,?,?,?,?,?,'PENDING',?)`).run(
        g.missIds[0], JSON.stringify(g.missIds), g.term || '', g.signalCount, g.action, g.targetConceptCode || null,
        JSON.stringify({ code: g.code, name: g.name, domainCode: g.domainCode, definition: g.definition, reason: g.reason, confidence: g.confidence, warnings: g.warnings }),
        run.lastInsertRowid);
      generated++;
    }
    await platform.prepare('INSERT INTO bm_proposal_run(scanned,generated_cnt,llm_failed,message) VALUES (?,?,?,?)')
      .run(candidates.length, generated, llmFailed, generated === 0 && llmFailed > 0 ? 'LLM 不可用，未生成提案（诚实留痕）' : null);
    res.json(ok({ scanned: candidates.length, generated, llmFailed }));
  } finally { proposalRunning = false; }
});
async function suggestProposal(miss) {
  const domains = await platform.prepare('SELECT code, name FROM bm_domain ORDER BY sort').all();
  const concepts = await platform.prepare('SELECT code, name, domain_code FROM bm_concept').all();
  const byDomain = {};
  for (const c of concepts) (byDomain[c.domain_code] = byDomain[c.domain_code] || []).push(c.code);
  const llm = await chat('MISS_PROPOSAL',
    '你是医疗本体治理专家。对词表外说法做近义预审并给出二选一判定。只返回 JSON。',
    `说法：「${miss.term}」（出现 ${miss.count} 次，来源 ${miss.source}）\n\n域：${domains.map(d => `${d.code}(${d.name})`).join('、')}\n概念：${Object.entries(byDomain).map(([d, cs]) => `${d}: ${cs.join('/')}`).join('；')}\n\n判定 NEW_CONCEPT（返回 {"action":"NEW_CONCEPT","term":"...","code":"...","name":"...","domainCode":"...","definition":"...","reason":"...","confidence":0.x}）或 ATTACH_TERM（返回 {"action":"ATTACH_TERM","term":"...","targetConceptCode":"...","reason":"...","confidence":0.x}）。编码若撞车请换码。`);
  const p = parseJsonLoose(llm);
  if (!p || !['NEW_CONCEPT', 'ATTACH_TERM'].includes(p.action)) return null;
  if (p.action === 'NEW_CONCEPT' && (!p.code || await platform.prepare('SELECT 1 FROM bm_concept WHERE code=?').get(p.code))) {
    p.warnings = ['编码已存在，需改码'];
  }
  return p;
}
R.post('/proposal/:id/adopt', async (req, res) => {
  const prop = await platform.prepare('SELECT * FROM bm_ontology_proposal WHERE id=?').get(req.params.id);
  if (!prop) throw new BizException('提案不存在');
  const r = await platform.prepare("UPDATE bm_ontology_proposal SET status='ADOPTED', decided_by=?, decided_at=? WHERE id=? AND status='PENDING'")
    .run(currentUser(req)?.username || '', now(), req.params.id);
  if (r.changes === 0) throw new BizException('提案已被裁决');
  const missIds = JSON.parse(prop.miss_ids);
  const suggestion = JSON.parse(prop.suggestion_json || '{}');
  try {
    if (prop.action === 'NEW_CONCEPT') {
      const first = await platform.prepare('SELECT * FROM bm_ontology_miss WHERE id=?').get(missIds[0]);
      if (!first || (first.adopted_concept_code && !first.revoked)) throw new BizException('主信号已被人工处置，请驳回本提案');
      if (await platform.prepare('SELECT 1 FROM bm_concept WHERE code=?').get(suggestion.code)) throw new BizException('概念编码已存在');
      await platform.prepare('INSERT INTO bm_concept(code,name,domain_code,definition,owner,status,version) VALUES (?,?,?,?,?,?,1)')
        .run(suggestion.code, suggestion.name, suggestion.domainCode || 'CLINICAL', suggestion.definition || '', '本体增长回路', 'DRAFT');
      for (const mid of missIds) {
        await platform.prepare('UPDATE bm_ontology_miss SET adopted_concept_code=?, adopted_as=?, revoked=0 WHERE id=?').run(suggestion.code, 'CONCEPT', mid);
      }
    } else {
      for (const mid of missIds) {
        const miss = await platform.prepare('SELECT * FROM bm_ontology_miss WHERE id=?').get(mid);
        if (!miss) continue;
        const exist = await platform.prepare('SELECT * FROM bm_term WHERE term=? AND source_product=?').get(miss.term, 'ONTOLOGY_MISS');
        if (exist) await platform.prepare('UPDATE bm_term SET concept_code=? WHERE id=?').run(prop.target_concept_code, exist.id);
        else await platform.prepare('INSERT INTO bm_term(term,concept_code,source_product,term_type,code_system) VALUES (?,?,?,?,?)').run(miss.term, prop.target_concept_code, 'ONTOLOGY_MISS', 'ALIAS', '平台标准');
        await platform.prepare('UPDATE bm_ontology_miss SET adopted_concept_code=?, adopted_as=?, revoked=0 WHERE id=?').run(prop.target_concept_code, 'TERM', mid);
      }
    }
  } catch (e) {
    await platform.prepare("UPDATE bm_ontology_proposal SET status='PENDING', decided_by=NULL, decided_at=NULL WHERE id=?").run(req.params.id);
    throw e;
  }
  res.json(ok(true));
});
R.post('/proposal/:id/reject', async (req, res) => {
  const r = await platform.prepare("UPDATE bm_ontology_proposal SET status='REJECTED', decided_by=?, decided_at=?, reject_reason=? WHERE id=? AND status='PENDING'")
    .run(currentUser(req)?.username || '', now(), req.body?.reason || '', req.params.id);
  if (r.changes === 0) throw new BizException('提案已被裁决');
  res.json(ok(true));
});

// ======================= 语义漂移 =======================
R.get('/drift/scan', async (req, res) => {
  // 术语分叉：同一术语挂到多个概念
  const terms = await platform.prepare('SELECT * FROM bm_term').all();
  const byTerm = new Map();
  for (const t of terms) {
    const arr = byTerm.get(t.term) || [];
    arr.push(t);
    byTerm.set(t.term, arr);
  }
  const termConflicts = [];
  for (const [term, usages] of byTerm) {
    const conceptSet = new Set(usages.map(u => u.concept_code));
    if (conceptSet.size >= 2) {
      termConflicts.push({
        term, conceptCount: conceptSet.size,
        usages: await Promise.all(usages.map(async u => {
          const cn = await platform.prepare('SELECT name FROM bm_concept WHERE code=?').get(u.concept_code);
          return {
            conceptCode: u.concept_code,
            conceptName: cn?.name || u.concept_code,
            sourceProduct: u.source_product, termType: u.term_type, codeSystem: u.code_system,
          };
        })),
      });
    }
  }
  termConflicts.sort((a, b) => b.conceptCount - a.conceptCount);
  // 口径演进：相邻发布版本快照对比
  const releases = await platform.prepare('SELECT id, version_tag, created_at, snapshot_json FROM bm_release ORDER BY id').all();
  const calibreChanges = [];
  for (let i = 1; i < releases.length; i++) {
    const prev = safeJson(releases[i - 1].snapshot_json), cur = safeJson(releases[i].snapshot_json);
    const prevC = new Map((prev.concepts || []).map(c => [c.code, c]));
    for (const c of (cur.concepts || [])) {
      const p = prevC.get(c.code);
      if (p && p.definition !== c.definition) {
        calibreChanges.push({ toReleaseId: releases[i].id, versionTag: releases[i].version_tag, releasedAt: releases[i].created_at, kind: '概念', code: c.code, name: c.name, field: 'definition', oldVal: p.definition, newVal: c.definition });
      }
    }
    const prevM = new Map((prev.metrics || []).map(m => [m.metric_code, m]));
    for (const m of (cur.metrics || [])) {
      const p = prevM.get(m.metric_code);
      if (p) {
        if (p.definition !== m.definition) calibreChanges.push({ toReleaseId: releases[i].id, versionTag: releases[i].version_tag, releasedAt: releases[i].created_at, kind: '指标', code: m.metric_code, name: m.name, field: 'definition', oldVal: p.definition, newVal: m.definition });
        if (p.formula !== m.formula) calibreChanges.push({ toReleaseId: releases[i].id, versionTag: releases[i].version_tag, releasedAt: releases[i].created_at, kind: '指标', code: m.metric_code, name: m.name, field: 'formula', oldVal: p.formula, newVal: m.formula });
      }
    }
  }
  calibreChanges.sort((a, b) => b.toReleaseId - a.toReleaseId);
  res.json(ok({ termConflicts, calibreChanges, stats: { scannedTerms: terms.length, scannedReleases: releases.length } }));
});
function safeJson(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

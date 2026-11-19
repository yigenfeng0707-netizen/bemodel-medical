import express from 'express';
import { platform, now } from './db.js';
import { BizException, ok } from './common.js';
import { currentUser, hasAnyRole } from './auth.js';
import { checkOntology } from './ontology.js';

export const releaseRouter = express.Router();
const R = releaseRouter;

const CLOSURE_MAX_DEPTH = 12;

/** 传递关系闭包物化：先删后插，返回每个传递关系名的统计 */
export async function rebuildRelationClosures() {
  const relations = await platform.prepare('SELECT * FROM bm_relation WHERE is_transitive=1').all();
  const stats = {};
  await platform.prepare('DELETE FROM bm_relation_closure').run();
  for (const rel of relations) {
    const edges = await platform.prepare('SELECT * FROM bm_relation WHERE relation_name=?').all(rel.relation_name);
    const adj = new Map();
    const sources = new Set();
    for (const e of edges) {
      if (!adj.has(e.from_concept)) adj.set(e.from_concept, []);
      adj.get(e.from_concept).push(e.to_concept);
      sources.add(e.from_concept);
    }
    let derived = 0, capped = false;
    const ins = platform.prepare('INSERT INTO bm_relation_closure(relation_name,from_concept,to_concept,depth) VALUES (?,?,?,?) ON CONFLICT DO NOTHING');
    for (const source of sources) {
      const depthOf = new Map();
      const queue = [];
      for (const next of (adj.get(source) || [])) {
        if (next === source) continue;
        if (!depthOf.has(next)) { depthOf.set(next, 1); queue.push(next); }
      }
      while (queue.length) {
        const cur = queue.shift();
        const d = depthOf.get(cur);
        if (d >= CLOSURE_MAX_DEPTH) { if ((adj.get(cur) || []).length) capped = true; continue; }
        for (const next of (adj.get(cur) || [])) {
          if (next === source) continue;
          if (!depthOf.has(next)) { depthOf.set(next, d + 1); queue.push(next); }
        }
      }
      for (const [to, depth] of depthOf) {
        await ins.run(rel.relation_name, source, to, depth);
        derived++;
      }
    }
    stats[rel.relation_name] = { edges: edges.length, derived, capped };
  }
  return stats;
}

async function nextTag() {
  const last = await platform.prepare('SELECT version_tag FROM bm_release ORDER BY id DESC LIMIT 1').get();
  if (!last) return 'v1.0';
  const m = String(last.version_tag).match(/^v(\d+)\.(\d+)$/);
  if (!m) return last.version_tag + '.1';
  return `v${m[1]}.${parseInt(m[2], 10) + 1}`;
}

R.get('/list', async (req, res) => {
  res.json(ok(await platform.prepare('SELECT id, version_tag, change_summary, element_count, released_by, approved_by, approved_at, created_at FROM bm_release ORDER BY id DESC').all()));
});
R.get('/current', async (req, res) => {
  const last = await platform.prepare('SELECT version_tag FROM bm_release ORDER BY id DESC LIMIT 1').get();
  res.json(ok({ version: last ? last.version_tag : '未发布' }));
});
R.get('/:id', async (req, res) => {
  const r = await platform.prepare('SELECT * FROM bm_release WHERE id=?').get(req.params.id);
  if (!r) throw new BizException('版本不存在');
  res.json(ok(r));
});
R.post('/publish', async (req, res) => {
  if (!hasAnyRole(req, 'REVIEWER', 'ADMIN')) throw new BizException('发布需评审员或管理员角色');
  const force = String(req.body?.force || '') === 'true';
  const { changeSummary, releasedBy } = req.body || {};
  const check = await checkOntology();
  if (check.blockerCount > 0) {
    throw new BizException(`存在 ${check.blockerCount} 个 BLOCKER 缺陷，拒绝发布：` + check.defects.filter(d => d.severity === 'BLOCKER').map(d => `[${d.type}] ${d.message}`).join('；'));
  }
  if (!force && check.defects.length > 0) {
    const warn = check.defects.filter(d => d.severity === 'WARN');
    res.json(ok({ needForce: true, defects: check.defects, message: `存在 ${warn.length} 个 WARN 缺陷，确认发布请传 force=true` }));
    return;
  }
  const concepts = await platform.prepare("SELECT * FROM bm_concept WHERE status='PUBLISHED' ORDER BY code").all();
  const conceptCodes = new Set(concepts.map(c => c.code));
  const attributes = concepts.length
    ? await platform.prepare(`SELECT * FROM bm_attribute WHERE concept_code IN (${[...conceptCodes].map(() => '?').join(',')}) ORDER BY concept_code, sort`).all(...conceptCodes)
    : [];
  const relations = await platform.prepare('SELECT * FROM bm_relation ORDER BY id').all();
  const terms = await platform.prepare('SELECT * FROM bm_term ORDER BY id').all();
  const metrics = await platform.prepare('SELECT * FROM bm_metric ORDER BY id').all();
  const rules = await platform.prepare("SELECT * FROM bm_rule WHERE status='PUBLISHED' ORDER BY rule_code").all();
  const actions = await platform.prepare("SELECT * FROM bm_action WHERE status='PUBLISHED' ORDER BY action_code").all();
  const closures = await rebuildRelationClosures();
  const elementCount = concepts.length + attributes.length + relations.length + terms.length + metrics.length + rules.length + actions.length;
  const snapshot = { concepts, attributes, relations, terms, metrics, rules, actions, relationClosures: closures };
  const user = currentUser(req);
  const tag = await nextTag();
  await platform.prepare(`INSERT INTO bm_release(version_tag, change_summary, element_count, snapshot_json, released_by, approved_by, approved_at, created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    tag, changeSummary || '', elementCount, JSON.stringify(snapshot), releasedBy || user?.username || '', user?.username || '', now(), now());
  res.json(ok({ versionTag: tag, elementCount, closures }));
});

// ======================= OWL 导入（Turtle / RDF-XML 轻量解析） =======================
export const owlRouter = express.Router();
owlRouter.post('/import/preview', async (req, res) => {
  res.json(ok(parseOwl(req.body?.content || '', req.body?.filename || 'upload.ttl')));
});
owlRouter.post('/import/execute', async (req, res) => {
  const plan = parseOwl(req.body?.content || '', req.body?.filename || 'upload.ttl');
  let domain = await platform.prepare("SELECT * FROM bm_domain WHERE code='IMPORT'").get();
  if (!domain) {
    await platform.prepare("INSERT INTO bm_domain(code,name,description,sort) VALUES ('IMPORT','OWL导入域','由 OWL 文件导入自动创建',99)").run();
  }
  let created = 0, updated = 0, skipped = 0;
  for (const item of plan.items) {
    if (item.kind === 'CLASS') {
      const exist = await platform.prepare('SELECT * FROM bm_concept WHERE code=?').get(item.code);
      if (exist && exist.iri && exist.iri !== item.iri) { item.disposition = 'KEY_TAKEN'; skipped++; continue; }
      if (exist) {
        await platform.prepare('UPDATE bm_concept SET name=?, iri=COALESCE(?, iri), updated_at=? WHERE code=?').run(item.name, item.iri, now(), item.code);
        item.disposition = 'UPDATE'; updated++;
      } else {
        await platform.prepare('INSERT INTO bm_concept(code,name,domain_code,definition,owner,status,version,iri) VALUES (?,?,?,?,?,?,1,?)')
          .run(item.code, item.name, 'IMPORT', item.definition || '', 'OWL导入', 'DRAFT', item.iri);
        item.disposition = 'CREATE'; created++;
      }
    } else if (item.kind === 'RELATION') {
      const exist = await platform.prepare('SELECT * FROM bm_relation WHERE from_concept=? AND to_concept=? AND relation_name=?').get(item.from, item.to, item.name);
      if (!exist) {
        await platform.prepare('INSERT INTO bm_relation(from_concept,to_concept,relation_name,description,is_symmetric,is_transitive,iri) VALUES (?,?,?,?,?,?,?)')
          .run(item.from, item.to, item.name, 'OWL 导入', item.sym ? 1 : 0, item.trans ? 1 : 0, item.iri || null);
        item.disposition = 'CREATE'; created++;
      } else { item.disposition = 'UPDATE'; updated++; }
    } else if (item.kind === 'ATTRIBUTE') {
      const exist = await platform.prepare('SELECT 1 FROM bm_attribute WHERE concept_code=? AND attr_code=?').get(item.concept, item.attrCode);
      if (!exist) {
        await platform.prepare('INSERT INTO bm_attribute(concept_code,attr_code,attr_name,data_type,is_key) VALUES (?,?,?,?,0)')
          .run(item.concept, item.attrCode, item.attrName, item.dataType);
        item.disposition = 'CREATE'; created++;
      } else { item.disposition = 'UPDATE'; updated++; }
    }
    if (item.kind === 'CLASS' && item.parents?.length) {
      for (const p of item.parents) {
        await platform.prepare('INSERT INTO bm_concept_parent(child_code,parent_code,is_primary) VALUES (?,?,?) ON CONFLICT DO NOTHING').run(item.code, p, item.primaryParent === p ? 1 : 0);
      }
      if (item.parents.length) {
        const axiomCode = 'AX-IMP-' + Math.abs(hash(item.iri || item.code)).toString(16).toUpperCase().padStart(8, '0');
        await platform.prepare('INSERT INTO bm_axiom(axiom_code,subject,predicate,object,axiom_type,description) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING')
          .run(axiomCode, item.code, 'subClassOf', item.parents.join(','), '继承', 'OWL 导入溯源');
      }
    }
  }
  res.json(ok({ summary: { created, updated, skipped, total: plan.items.length }, unprojected: plan.unprojected, items: plan.items }));
});
function hash(s) { let h = 0; for (const ch of String(s)) { h = (h * 31 + ch.charCodeAt(0)) | 0; } return h; }

/** 轻量 OWL/Turtle 解析：支持 owl:Class、ObjectProperty、DatatypeProperty、subClassOf 常见形态 */
export function parseOwl(content, filename) {
  const items = [];
  const unprojected = [];
  const isTurtle = /\.ttl$/i.test(filename) || /@prefix|^\s*\S+\s+a\s+owl:/m.test(content) && !/<\?xml|<rdf:RDF/i.test(content);
  if (isTurtle) return parseTurtle(content, unprojected, items);
  return parseRdfXml(content, unprojected, items);
}

function localName(iri) {
  const s = String(iri);
  const i = Math.max(s.lastIndexOf('#'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(i + 1).replace(/[>\s]/g, '') : s;
}
function toUpperSnake(name) {
  let s = String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase().replace(/^_+|_+$/g, '');
  if (/^\d/.test(s)) s = 'C_' + s;
  return (s || 'OWL_' + Math.abs(hash(name))).slice(0, 64);
}
function rangeToType(range) {
  const r = String(range || '').toLowerCase();
  if (/integer|int|long|float|double|decimal/.test(r)) return 'NUMBER';
  if (/date|datetime|time/.test(r)) return 'DATE';
  if (/boolean/.test(r)) return 'ENUM';
  return 'STRING';
}

function parseTurtle(content, unprojected, items) {
  // 去注释，按语句切分的简化 Turtle 解析
  const prefixes = {};
  let text = content.replace(/#[^\n]*/g, '');
  text = text.replace(/@prefix\s+([\w-]*):\s*<([^>]+)>\s*\./g, (m, p, u) => { prefixes[p] = u; return ''; });
  const statements = text.split(/\.\s*\n|\;\s*\n/);
  for (const st of statements) {
    const classM = st.match(/<([^>]+)>\s+a\s+(?:owl:|<http:\/\/www\.w3\.org\/2002\/07\/owl#)(Class)\s*;/) || st.match(/<([^>]+)>\s+a\s+owl:Class\s*\./);
    if (classM) {
      const iri = classM[1];
      const item = { kind: 'CLASS', iri, name: localName(iri), code: toUpperSnake(localName(iri)), definition: '', parents: [], primaryParent: null, disposition: 'CREATE' };
      const sub = st.match(/rdfs:subClassOf\s+<([^>]+)>/);
      if (sub) { item.parents.push(toUpperSnake(localName(sub[1]))); item.primaryParent = item.parents[0]; }
      const label = st.match(/rdfs:label\s+"([^"]+)"/);
      if (label) item.name = label[1];
      items.push(item);
      continue;
    }
    const opM = st.match(/<([^>]+)>\s+a\s+owl:ObjectProperty([\s\S]*)/);
    if (opM) {
      const iri = opM[1], rest = opM[2];
      const domain = (rest.match(/rdfs:domain\s+<([^>]+)>/) || [])[1];
      const range = (rest.match(/rdfs:range\s+<([^>]+)>/) || [])[1];
      if (!domain || !range) { unprojected.push(`ObjectProperty ${localName(iri)} 缺 domain/range`); continue; }
      const item = {
        kind: 'RELATION', iri, name: localName(iri),
        from: toUpperSnake(localName(domain)), to: toUpperSnake(localName(range)),
        sym: /owl:SymmetricProperty|Symmetric/.test(rest), trans: /owl:TransitiveProperty|Transitive/.test(rest),
        disposition: 'CREATE',
      };
      const inv = (rest.match(/owl:inverseOf\s+<([^>]+)>/) || [])[1];
      if (inv) item.inverseOf = localName(inv);
      items.push(item);
      continue;
    }
    const dpM = st.match(/<([^>]+)>\s+a\s+owl:DatatypeProperty([\s\S]*)/);
    if (dpM) {
      const iri = dpM[1], rest = dpM[2];
      const domain = (rest.match(/rdfs:domain\s+<([^>]+)>/) || [])[1];
      const range = (rest.match(/rdfs:range\s+<([^>]+)>/) || [])[1];
      if (!domain) { unprojected.push(`DatatypeProperty ${localName(iri)} 缺 domain`); continue; }
      const item = {
        kind: 'ATTRIBUTE', concept: toUpperSnake(localName(domain)), attrCode: toUpperSnake(localName(iri)).slice(0, 64),
        attrName: localName(iri), dataType: rangeToType(range), disposition: 'CREATE',
      };
      if (!range) item.definition = 'DEGRADED_TO_STRING：无 range，降级 STRING';
      items.push(item);
      continue;
    }
    if (/owl:Restriction|owl:disjointWith|owl:equivalentClass|NamedIndividual/.test(st) && st.trim()) {
      unprojected.push(st.trim().slice(0, 60));
    }
  }
  return { items, unprojected };
}

function parseRdfXml(content, unprojected, items) {
  const classRe = /<(?:[\w-]+:)?Class\s+rdf:about="([^"]+)"([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?Class>/g;
  let m;
  while ((m = classRe.exec(content))) {
    const item = { kind: 'CLASS', iri: m[1], name: localName(m[1]), code: toUpperSnake(localName(m[1])), definition: '', parents: [], primaryParent: null, disposition: 'CREATE' };
    const label = m[3].match(/<(?:[\w-]+:)?label[^>]*>([^<]+)</);
    if (label) item.name = label[1];
    const sub = m[3].match(/<(?:[\w-]+:)?subClassOf\s+rdf:resource="([^"]+)"/);
    if (sub) { item.parents.push(toUpperSnake(localName(sub[1]))); item.primaryParent = item.parents[0]; }
    items.push(item);
  }
  const opRe = /<(?:[\w-]+:)?ObjectProperty\s+rdf:about="([^"]+)"([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?ObjectProperty>/g;
  while ((m = opRe.exec(content))) {
    const domain = m[3].match(/<(?:[\w-]+:)?domain\s+rdf:resource="([^"]+)"/);
    const range = m[3].match(/<(?:[\w-]+:)?range\s+rdf:resource="([^"]+)"/);
    if (!domain || !range) { unprojected.push(`ObjectProperty ${localName(m[1])} 缺 domain/range`); continue; }
    items.push({
      kind: 'RELATION', iri: m[1], name: localName(m[1]),
      from: toUpperSnake(localName(domain[1])), to: toUpperSnake(localName(range[1])),
      sym: /SymmetricProperty/.test(m[3]), trans: /TransitiveProperty/.test(m[3]), disposition: 'CREATE',
    });
  }
  const dpRe = /<(?:[\w-]+:)?DatatypeProperty\s+rdf:about="([^"]+)"([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?DatatypeProperty>/g;
  while ((m = dpRe.exec(content))) {
    const domain = m[3].match(/<(?:[\w-]+:)?domain\s+rdf:resource="([^"]+)"/);
    const range = m[3].match(/<(?:[\w-]+:)?range\s+rdf:resource="([^"]+)"/);
    if (!domain) { unprojected.push(`DatatypeProperty ${localName(m[1])} 缺 domain`); continue; }
    items.push({
      kind: 'ATTRIBUTE', concept: toUpperSnake(localName(domain[1])), attrCode: toUpperSnake(localName(m[1])).slice(0, 64),
      attrName: localName(m[1]), dataType: rangeToType(range?.[1]), disposition: 'CREATE',
    });
  }
  return { items, unprojected };
}

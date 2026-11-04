import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import multer from 'multer';
import { platform, now } from './db.js';
import { config } from './config.js';
import { BizException, ok, checkTransition } from './common.js';
import { currentUser, hasAnyRole } from './auth.js';
import { recordMiss } from './ontology.js';

export const knowledgeRouter = express.Router();
const R = knowledgeRouter;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const EMBED_BATCH = 16;

// ==================== 文档解析（Tika 替代：md/txt 原生 + docx 最小 ZIP 解析） ====================
function extractDocxText(buf) {
  // 最小 ZIP 读取：定位 local file header，inflateRaw 解压 word/document.xml，剥标签取纯文本
  let xml = '';
  let off = 0;
  const b = buf;
  while (off < b.length - 4) {
    if (b.readUInt32LE(off) === 0x04034b50) {
      const method = b.readUInt16LE(off + 8);
      const compSize = b.readUInt32LE(off + 18);
      const nameLen = b.readUInt16LE(off + 26);
      const extraLen = b.readUInt16LE(off + 28);
      const name = b.subarray(off + 30, off + 30 + nameLen).toString('utf8');
      const dataStart = off + 30 + nameLen + extraLen;
      if (name === 'word/document.xml') {
        const data = b.subarray(dataStart, dataStart + compSize);
        xml = method === 8 ? zlib.inflateRawSync(data).toString('utf8') : data.toString('utf8');
        break;
      }
      off = dataStart + (compSize || b.length);
    } else off++;
  }
  if (!xml) throw new BizException('DOCX 解析失败：未找到 document.xml（可能为损坏文件）');
  return xml
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<[^>]+>/g, (tag) => (tag.startsWith('<w:p') ? '\n' : ''))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function docTypeOf(filename) {
  const ext = path.extname(filename || '').toLowerCase().replace('.', '');
  return ['md', 'pdf', 'docx', 'txt'].includes(ext) ? ext.toUpperCase() : null;
}
export function parseDoc(filename, buf) {
  const type = docTypeOf(filename);
  if (!type) throw new BizException('仅支持 .md/.pdf/.docx/.txt 文档');
  let text = '';
  if (type === 'DOCX') text = extractDocxText(buf);
  else if (type === 'PDF') {
    // 最小 PDF 文本抽取：解压 FlateDecode 流并抽取括号字符串
    const parts = [];
    const raw = buf.toString('latin1');
    const re = /stream\r?\n([\s\S]*?)endstream/g;
    let m;
    while ((m = re.exec(raw))) {
      try {
        const data = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
        const textRe = /\((?:\\.|[^\\()])*\)/g;
        let t; let s = '';
        while ((t = textRe.exec(data))) s += t[0].slice(1, -1).replace(/\\([()\\])/g, '$1');
        if (s.trim()) parts.push(s);
      } catch { /* 非压缩流跳过 */ }
    }
    text = parts.join('\n');
    if (!text.trim()) throw new BizException('PDF 解析失败：未能抽取文本（扫描件不支持，OCR 明确不做）');
  } else text = buf.toString('utf8');
  if (!text.trim()) throw new BizException('解析结果为空（损坏或纯扫描件），拒收');
  return text;
}

// ==================== 切分（500 字 / 重叠 50，按 Markdown 标题维护 heading 路径） ====================
export function chunkText(text, size = config.chunk.size, overlap = config.chunk.overlap) {
  const chunks = [];
  let heading = '';
  let buf = '';
  const flush = () => {
    let t = buf.trim();
    while (t.length > size) {
      chunks.push({ heading, content: t.slice(0, size) });
      t = t.slice(size - overlap);
    }
    if (t) chunks.push({ heading, content: t });
    buf = '';
  };
  for (const para of text.split(/\n\s*\n/)) {
    const h = para.match(/^\s*#+\s*(.+)$/m);
    if (h) { heading = h[1].trim(); }
    const clean = para.replace(/^#+\s*.*$/m, '').trim();
    if (!clean) continue;
    if (buf && (buf + '\n' + clean).length > size) flush();
    buf = buf ? buf + '\n' + clean : clean;
  }
  flush();
  return chunks;
}

// ==================== 向量化（OpenAI 兼容 /embeddings；任何失败返回空数组降级） ====================
export async function embed(texts, callType = 'EMBED_INGEST') {
  const ep = config.embedding;
  if (!ep.baseUrl) return [];
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ep.timeoutMs);
    const resp = await fetch(ep.baseUrl.replace(/\/+$/, '') + '/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(ep.apiKey ? { Authorization: `Bearer ${ep.apiKey}` } : {}) },
      body: JSON.stringify({ model: ep.model, input: texts }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = await resp.json();
    const data = (body.data || []).slice().sort((a, b) => a.index - b.index).map(d => d.embedding);
    logEmbed(callType, true, Date.now() - started, null);
    return data;
  } catch (e) {
    logEmbed(callType, false, Date.now() - started, String(e.message || e).slice(0, 200));
    return [];
  }
}
function logEmbed(callType, success, latencyMs, errMsg) {
  try {
    platform.prepare('INSERT INTO bm_llm_log(call_type,provider,model,ontology_version,prompt_digest,latency_ms,success,err_msg) VALUES (?,?,?,?,?,?,?,?)')
      .run(callType, 'ollama', config.embedding.model, null, null, latencyMs, success ? 1 : 0, errMsg);
  } catch { /* ignore */ }
}
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ==================== 混合检索（FTS5 关键词 + 向量余弦 → RRF k=60） ====================
function fulltextQuery(q) {
  // 连续中文段滑窗取二字 bigram；英文数字整词；单字剥掉；词项封顶 24
  const terms = [];
  const segRe = /[\u4e00-\u9fa5]+|[a-zA-Z0-9]+/g;
  let m;
  while ((m = segRe.exec(q))) {
    const seg = m[0];
    if (/^[\u4e00-\u9fa5]+$/.test(seg)) {
      for (let i = 0; i + 1 < seg.length; i++) terms.push(`"${seg.slice(i, i + 2)}"`);
    } else if (seg.length >= 2) terms.push(`"${seg.toLowerCase()}"`);
  }
  // FTS5 多词默认 AND，bigram 全 AND 对自然语句几乎必 0 命中，改 OR 提升召回
  return [...new Set(terms)].slice(0, 24).join(' OR ');
}
export async function knowledgeSearch(q, topN = 5) {
  const ftsQ = fulltextQuery(q);
  let keywordHits = [];
  if (ftsQ) {
    try {
      keywordHits = platform.prepare(`
        SELECT c.id, c.document_id, c.seq, c.heading, c.content,
               bm25(bm_doc_chunk_fts) AS rank,
               (SELECT title FROM bm_document d WHERE d.id=c.document_id AND d.status='PUBLISHED') AS docTitle
        FROM bm_doc_chunk_fts f JOIN bm_doc_chunk c ON c.rowid=f.rowid
        WHERE bm_doc_chunk_fts MATCH ? ORDER BY rank LIMIT 20`).all(ftsQ).filter(r => r.docTitle);
    } catch { keywordHits = []; }
  }
  // 向量路
  let vectorHits = [];
  const [qv] = await embed([q], 'EMBED_QUERY');
  if (qv) {
    const rows = platform.prepare(`SELECT c.id, c.document_id, c.seq, c.heading, c.content, c.embedding,
      (SELECT title FROM bm_document d WHERE d.id=c.document_id) AS docTitle
      FROM bm_doc_chunk c JOIN bm_document d ON d.id=c.document_id
      WHERE d.status='PUBLISHED' AND c.embedding IS NOT NULL LIMIT 5000`).all();
    vectorHits = rows.map(r => ({ ...r, score: cosine(qv, JSON.parse(r.embedding)) }))
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
  }
  // RRF 融合：score(d) = Σ 1/(k + rank)，k=60
  const RRF_K = 60;
  const fused = new Map();
  const addRank = (list, keyFn) => list.forEach((item, i) => {
    const k = keyFn(item);
    const cur = fused.get(k) || { item, score: 0 };
    cur.score += 1.0 / (RRF_K + i + 1);
    fused.set(k, cur);
  });
  addRank(keywordHits, r => r.id);
  addRank(vectorHits, r => r.id);
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, topN)
    .map(({ item }) => ({ documentId: item.document_id, seq: item.seq, heading: item.heading, content: item.content, docTitle: item.docTitle }));
}

// ==================== 文档生命周期 ====================
R.get('/documents', (req, res) => {
  const rows = platform.prepare(`
    SELECT d.*, (SELECT COUNT(*) FROM bm_doc_chunk c WHERE c.document_id=d.id) chunk_count
    FROM bm_document d ORDER BY d.id DESC`).all();
  res.json(ok(rows));
});
// 中文 bigram 预切分：unicode61 分词器会把连续中文切成单 token，bigram 查询无法命中；
// 索引侧把中文段预切成空格分隔的二字词，与 fulltextQuery 的 bigram 查询构造对齐
function cjkBigramText(text) {
  return text.replace(/[\u4e00-\u9fa5]+/g, seg => {
    if (seg.length === 1) return seg;
    const parts = [];
    for (let i = 0; i + 1 < seg.length; i++) parts.push(seg.slice(i, i + 2));
    return parts.join(' ');
  });
}

R.post('/documents', upload.single('file'), async (req, res) => {
  const buf = req.file?.buffer;
  if (!buf) throw new BizException('请上传文件');
  // multer 1.x 按 latin1 解析 multipart 文件名，中文需还原为 UTF-8（纯 ASCII 无损）
  const filename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const title = path.basename(filename, path.extname(filename));
  const text = parseDoc(filename, buf);
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const dup = platform.prepare("SELECT id FROM bm_document WHERE content_hash=? AND status<>'DEPRECATED'").get(hash);
  if (dup) throw new BizException('内容重复：相同内容文档已存在');
  const verRow = platform.prepare('SELECT COALESCE(MAX(version),0)+1 v FROM bm_document WHERE title=?').get(title);
  const r = platform.prepare(`INSERT INTO bm_document(title,doc_type,source,status,version,owner,uploaded_by,file_size,content_hash,content_text)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(title, docTypeOf(filename), 'UPLOAD', 'DRAFT', verRow.v, req.body?.owner || currentUser(req)?.displayName || '', currentUser(req)?.username || '', buf.length, hash, text);
  const docId = r.lastInsertRowid;
  const chunks = chunkText(text);
  const insChunk = platform.prepare('INSERT INTO bm_doc_chunk(document_id,seq,heading,content) VALUES (?,?,?,?)');
  const insFts = platform.prepare('INSERT INTO bm_doc_chunk_fts(content) VALUES (?)');
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const vectors = await embed(batch.map(c => c.content));
    batch.forEach((c, j) => {
      const rr = insChunk.run(docId, i + j, c.heading, c.content);
      if (vectors[j]) platform.prepare('UPDATE bm_doc_chunk SET embedding=? WHERE id=?').run(JSON.stringify(vectors[j]), rr.lastInsertRowid);
      insFts.run(cjkBigramText(c.content));
    });
  }
  res.json(ok({ id: docId, chunks: chunks.length }));
});
R.get('/documents/:id/chunks', (req, res) => {
  res.json(ok(platform.prepare('SELECT id, seq, heading, content, (embedding IS NOT NULL) AS has_embedding FROM bm_doc_chunk WHERE document_id=? ORDER BY seq').all(req.params.id)));
});
// 运维端点：重嵌 NULL 分块（向量路曾不可用时的补齐入口；失败分块保持 NULL，诚实降级走关键词路）
R.post('/documents/revectorize', async (req, res) => {
  const rows = platform.prepare('SELECT id, content FROM bm_doc_chunk WHERE embedding IS NULL ORDER BY id').all();
  let updated = 0;
  for (let i = 0; i < rows.length; i += EMBED_BATCH) {
    const batch = rows.slice(i, i + EMBED_BATCH);
    const vectors = await embed(batch.map(r => r.content));
    batch.forEach((r, j) => {
      if (vectors[j]) {
        platform.prepare('UPDATE bm_doc_chunk SET embedding=? WHERE id=?').run(JSON.stringify(vectors[j]), r.id);
        updated++;
      }
    });
  }
  res.json(ok({ updated, remaining: platform.prepare('SELECT COUNT(*) n FROM bm_doc_chunk WHERE embedding IS NULL').get().n }));
});
R.post('/documents/:id/transition', (req, res) => {
  const doc = platform.prepare('SELECT * FROM bm_document WHERE id=?').get(req.params.id);
  if (!doc) throw new BizException('文档不存在');
  const target = req.body?.target || req.query.target;
  checkTransition(doc.status, target);
  if (target === 'PUBLISHED') {
    if (!hasAnyRole(req, 'REVIEWER', 'ADMIN')) throw new BizException('发布需评审员或管理员');
    if (currentUser(req).role === 'REVIEWER' && doc.uploaded_by && doc.uploaded_by === currentUser(req).username) {
      throw new BizException('评审员不得发布本人上传的文档（防自审）');
    }
    platform.prepare("UPDATE bm_document SET status='DEPRECATED' WHERE title=? AND status='PUBLISHED' AND id<>?").run(doc.title, doc.id);
  }
  platform.prepare('UPDATE bm_document SET status=?, updated_at=? WHERE id=?').run(target, now(), doc.id);
  res.json(ok(true));
});
R.delete('/documents/:id', (req, res) => {
  const doc = platform.prepare('SELECT * FROM bm_document WHERE id=?').get(req.params.id);
  if (!doc) throw new BizException('文档不存在');
  if (doc.status === 'PUBLISHED') throw new BizException('已发布文档不可删除，只可停用');
  platform.prepare('DELETE FROM bm_doc_chunk WHERE document_id=?').run(doc.id);
  platform.prepare('DELETE FROM bm_document WHERE id=?').run(doc.id);
  res.json(ok(true));
});

// ==================== 知识条目 ====================
R.get('/entries', (req, res) => {
  res.json(ok(platform.prepare('SELECT * FROM bm_knowledge ORDER BY id').all()));
});
R.post('/entries', (req, res) => {
  const b = req.body || {};
  if (!b.code || !b.title || !b.content) throw new BizException('编码/标题/内容不能为空');
  if (platform.prepare('SELECT 1 FROM bm_knowledge WHERE code=?').get(b.code)) throw new BizException('条目编码已存在');
  platform.prepare('INSERT INTO bm_knowledge(code,title,content,applies_to,concept_code,source,status,version,owner) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(b.code, b.title, b.content, b.appliesTo || '', b.conceptCode || null, 'ADMIN', 'DRAFT', 1, b.owner || currentUser(req)?.displayName || '');
  res.json(ok(true));
});
R.put('/entries/:id', (req, res) => {
  const e = platform.prepare('SELECT * FROM bm_knowledge WHERE id=?').get(req.params.id);
  if (!e) throw new BizException('条目不存在');
  // 已发布条目再次保存自动回 REVIEW（改一条走审批）
  const nextStatus = e.status === 'PUBLISHED' ? 'REVIEW' : e.status;
  platform.prepare('UPDATE bm_knowledge SET title=?, content=?, applies_to=?, owner=?, status=?, updated_at=? WHERE id=?')
    .run(req.body.title ?? e.title, req.body.content ?? e.content, req.body.appliesTo ?? e.applies_to,
      req.body.owner ?? e.owner, nextStatus, now(), e.id);
  res.json(ok(true));
});
R.post('/entries/:id/transition', (req, res) => {
  const e = platform.prepare('SELECT * FROM bm_knowledge WHERE id=?').get(req.params.id);
  if (!e) throw new BizException('条目不存在');
  const target = req.body?.target || req.query.target;
  checkTransition(e.status, target);
  if (target === 'PUBLISHED' && !hasAnyRole(req, 'REVIEWER', 'ADMIN')) throw new BizException('发布需评审员或管理员');
  platform.prepare('UPDATE bm_knowledge SET status=?, version=version+?, updated_at=? WHERE id=?').run(target, target === 'PUBLISHED' ? 1 : 0, now(), e.id);
  res.json(ok(true));
});

// 统一读取口：仅 PUBLISHED 返回正文
export function entryContent(code) {
  const e = platform.prepare("SELECT content FROM bm_knowledge WHERE code=? AND status='PUBLISHED'").get(code);
  return e ? e.content : null;
}
export function basisEntries(conceptCode) {
  return platform.prepare("SELECT code, title, content FROM bm_knowledge WHERE status='PUBLISHED' AND (',' || applies_to || ',') LIKE ? ORDER BY id").all(`%,${conceptCode},%`);
}

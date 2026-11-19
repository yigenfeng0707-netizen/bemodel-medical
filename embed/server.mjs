// 本地向量化服务：OpenAI 兼容 /v1/embeddings，模型 bge-small-zh-v1.5（ONNX 量化，512 维）
// 仅监听 127.0.0.1:11435，由容器入口脚本拉起，供后端 EMBEDDING_BASE_URL 调用
import http from 'node:http';
import path from 'node:path';
import { pipeline, env } from '@huggingface/transformers';

const MODEL = process.env.EMBEDDING_MODEL || 'bge-small-zh-v1.5';
const PORT = parseInt(process.env.EMBED_PORT || '11435', 10);
const MODEL_ROOT = process.env.EMBED_MODEL_ROOT || '/app/embed/model';

env.localModelPath = MODEL_ROOT;
env.allowRemoteModels = false;
env.allowLocalModels = true;

let extractorPromise = null;
function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', MODEL, { dtype: 'q8' }).catch((e) => {
      extractorPromise = null;
      throw e;
    });
  }
  return extractorPromise;
}

const server = http.createServer(async (req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && req.url === '/health') return json(200, { status: 'ok', model: MODEL });
  if (req.method !== 'POST' || !req.url.startsWith('/v1/embeddings')) return json(404, { error: { message: 'not found' } });

  let raw = '';
  try {
    for await (const chunk of req) raw += chunk;
    const { input } = JSON.parse(raw || '{}');
    const texts = Array.isArray(input) ? input : [input];
    if (!texts.length || texts.some((t) => typeof t !== 'string')) return json(400, { error: { message: 'invalid input' } });

    const t0 = Date.now();
    const extractor = await getExtractor();
    const tensor = await extractor(texts, { pooling: 'cls', normalize: true });
    const vectors = tensor.tolist();
    const data = vectors.map((embedding, index) => ({ object: 'embedding', index, embedding }));
    console.log(`[embed] ${texts.length} text(s) dim=${vectors[0].length} ${Date.now() - t0}ms`);
    return json(200, { object: 'list', data, model: MODEL, usage: { prompt_tokens: 0, total_tokens: 0 } });
  } catch (e) {
    console.error('[embed] failed:', e.message || e);
    return json(500, { error: { message: String(e.message || e).slice(0, 300) } });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`[embed] listening on 127.0.0.1:${PORT}, model=${MODEL}, root=${MODEL_ROOT}`));

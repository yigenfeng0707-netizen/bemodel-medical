import WebSocket from 'ws';
import fs from 'node:fs';
const sess = JSON.parse(fs.readFileSync('D:/Apps/本体bemodel医疗/data/jupyter_session.json', 'utf8'));
const base = sess.baseUrl;
const variants = [
  { name: 'origin=discovery.intern-ai', h: { Origin: 'https://discovery.intern-ai.org.cn' } },
  { name: 'no-origin', h: {} },
  { name: 'origin=self+accept', h: { Origin: 'https://discovery-notebook-p.intern-ai.org.cn', Accept: '*/*', 'Accept-Language': 'zh-CN' } },
];
const resp = await fetch(base + '/api/terminals', { method: 'POST', headers: { Cookie: sess.cookie, 'X-Xsrftoken': sess.xsrf } });
const name = (await resp.json()).name;
console.log('terminal:', name);
const url = base.replace('https://', 'wss://') + `terminals/websocket/${name}`;
for (const v of variants) {
  const result = await new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { Cookie: sess.cookie, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/156.0.0.0 Safari/537.36', ...v.h } });
    const t = setTimeout(() => { try { ws.terminate(); } catch {} resolve('TIMEOUT'); }, 8000);
    ws.on('open', () => { clearTimeout(t); try { ws.close(); } catch {} resolve('OPEN'); });
    ws.on('error', (e) => { clearTimeout(t); resolve('ERR ' + e.message); });
    ws.on('unexpected-response', (req, res) => { clearTimeout(t); resolve('HTTP ' + res.statusCode); });
  });
  console.log(v.name, '→', result);
  if (result === 'OPEN') process.exit(0);
}

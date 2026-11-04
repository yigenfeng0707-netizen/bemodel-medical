import WebSocket from 'ws';
import fs from 'node:fs';
const sess = JSON.parse(fs.readFileSync('D:/Apps/本体bemodel医疗/data/jupyter_session.json', 'utf8'));
const base = sess.baseUrl;
// 先创建一个终端（Python requests 风格用 fetch + cookie）
const resp = await fetch(base + '/api/terminals', { method: 'POST', headers: { Cookie: sess.cookie, 'X-Xsrftoken': sess.xsrf } });
if (!resp.ok) { console.log('create fail', resp.status, (await resp.text()).slice(0, 120)); process.exit(1); }
const name = (await resp.json()).name;
console.log('terminal:', name);
const url = base.replace('https://', 'wss://') + `terminals/websocket/${name}`;
const ws = new WebSocket(url, {
  headers: {
    Cookie: sess.cookie,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
    Origin: 'https://discovery-notebook-p.intern-ai.org.cn',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  },
});
const done = (code, msg) => { try { ws.close(); } catch {} console.log(code, msg); process.exit(0); };
ws.on('open', () => { console.log('WS OPEN!'); ws.send(JSON.stringify(['stdin', 'echo NODE_WS_OK\n'])); });
ws.on('message', (d) => { const s = d.toString(); if (s.includes('NODE_WS_OK')) done('VERIFY', 'terminal roundtrip OK'); });
ws.on('error', (e) => done('ERR', e.message));
ws.on('unexpected-response', (req, res) => done('HTTP', res.statusCode));
setTimeout(() => done('TIMEOUT', ''), 15000);

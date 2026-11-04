# -*- coding: utf-8 -*-
"""开发机命令执行器（Jupyter 终端 WS，浏览器通道），每次命令新建终端防卡死。
用法: python dep.py "命令" [超时秒]
"""
import json, sys, time
from playwright.sync_api import sync_playwright

WS_TPL = "wss://discovery-notebook-p.intern-ai.org.cn/notebook/292100386/nb-4353529c2d4a994d3680291617bc1b65/notebook/terminals/websocket/{name}"
INJECT = ("(wsUrl) => { if (window.__tws) { try{window.__tws.onclose=null;window.__tws.close()}catch(e){} } window.__tws_out = []; const ws = new WebSocket(wsUrl); window.__tws = ws; "
          "ws.onmessage = (e) => { window.__tws_out.push(String(e.data)); "
          "if (window.__tws_out.length > 4000) window.__tws_out.splice(0, 2000); }; return 'OK'; }")
BASE = "https://discovery-notebook-p.intern-ai.org.cn/notebook/292100386/nb-4353529c2d4a994d3680291617bc1b65/notebook"


INSIDE = "https://discovery.intern-ai.org.cn/compute/dev-machine/inside/4564/nb-4353529c2d4a994d3680291617bc1b65"

def get_ctx(p):
    b = p.chromium.connect_over_cdp("http://127.0.0.1:9223")
    ctx = b.contexts[0]
    pg = next((x for x in ctx.pages if "/inside/" in x.url), None)
    if not pg:
        pg = ctx.new_page()
        pg.goto(INSIDE, timeout=60000, wait_until="domcontentloaded")
        pg.wait_for_timeout(8000)
    fr = None
    for _ in range(10):
        frs = [x for x in pg.frames if "discovery-notebook-p" in x.url and x != pg.main_frame]
        if frs:
            cand = [f for f in frs if '/code/' in f.url or '/notebook/' in f.url.split('/')[-1]]
            fr = (cand or frs)[0]
            try:
                if fr.evaluate("() => document.body && document.body.innerText.length > 0"): break
            except Exception: pass
        pg.wait_for_timeout(2000)
    if fr is None: raise Exception('notebook frame not found')
    return pg, fr


def fresh_terminal(fr, pg):
    r = fr.evaluate(f"""async () => {{
      let m = document.cookie.match(/_xsrf=([^;]+)/);
      if (!m) {{ await fetch('{BASE}/api/status', {{cache:'no-store'}}); await new Promise(r2=>setTimeout(r2,800)); m = document.cookie.match(/_xsrf=([^;]+)/); }}
      const xsrf = m ? m[1] : '';
      const resp = await fetch('{BASE}/api/terminals', {{method:'POST', headers:{{'X-Xsrftoken': xsrf}}}});
      return {{s: resp.status, b: await resp.text()}};
    }}""")
    if r['s'] != 200:
        raise Exception('terminal create fail: ' + r['b'][:120])
    name = json.loads(r['b'])['name']
    fr.evaluate(INJECT, WS_TPL.format(name=name))
    pg.wait_for_timeout(2200)
    return name


def purge_all(fr):
    try:
        fr.evaluate(
            "async () => {"
            "  const m = document.cookie.match(new RegExp('_xsrf=([^;]+)'));"
            "  const h = {'X-Xsrftoken': m ? m[1] : ''};"
            "  const B = '" + BASE + "';"
            "  const list = await (await fetch(B + '/api/terminals', {headers: h})).json();"
            "  for (const t of list) { try { await fetch(B + '/api/terminals/' + t.name, {method: 'DELETE', headers: h}); } catch (e) {} }"
            "  return list.length;"
            "}")
        return True
    except Exception:
        return False


def run_cmd(fr, pg, cmd, timeout=100):
    # 回显与执行输出用 $$ 区分：回显里是字面 "$$"，执行时是数字 PID
    import re as _re
    n0 = fr.evaluate("() => window.__tws_out.length")
    marker = "MK" + str(int(time.time() * 1000))[-8:]
    payload = "echo " + marker + "_S_$$\n" + cmd + "\necho " + marker + "_E_$$\n"
    fr.evaluate("(a) => window.__tws.send(JSON.stringify(['stdin', a]))", payload)
    buf = []
    t0 = time.time()
    began = False
    end = False
    while time.time() - t0 < timeout:
        pg.wait_for_timeout(500)
        allout = fr.evaluate("() => window.__tws_out")
        new = allout[n0:]
        n0 = len(allout)
        for part in new:
            try:
                arr = json.loads(part)
                if isinstance(arr, list) and len(arr) == 2 and arr[0] in ("stdout", "stderr"):
                    s = arr[1]
                    buf.append(s)
                    if not began and _re.search(marker + r"_S_\d+", s):
                        began = True
                    elif began and _re.search(marker + r"_E_\d+", s):
                        end = True
            except Exception:
                pass
        if end:
            break
    text = "".join(buf).replace("\r\n", "\n")
    i = text.find(marker + "_S_")
    if i >= 0:
        nl = text.find("\n", i)
        text = text[nl + 1:] if nl >= 0 else ""
    j = _re.search(marker + r"_E_\d+", text)
    if j:
        text = text[:j.start()]
    return text.strip()


def main():
    cmd = sys.argv[1]
    timeout = int(sys.argv[2]) if len(sys.argv) > 2 else 100
    with sync_playwright() as p:
        pg, fr = None, None
        for attempt in range(3):
            try:
                pg, fr = get_ctx(p)
                break
            except Exception as e:
                print(f'[retry {attempt}] {str(e)[:80]}', file=sys.stderr)
                time.sleep(3)
        if fr is None:
            print('FATAL: cannot reach dev machine page', file=sys.stderr)
            sys.exit(2)
        name = fresh_terminal(fr, pg)
        try:
            out = run_cmd(fr, pg, cmd, timeout)
            if not out or out.count(chr(10)) == 0:
                # 疑似终端堆积（bash 起不来）：大扫除后重试
                purge_all(fr)
                time.sleep(6)
                name = fresh_terminal(fr, pg)
                out = run_cmd(fr, pg, cmd, timeout)
            print(out)
        finally:
            try:
                fr.evaluate("() => { if (window.__tws) { try{window.__tws.close()}catch(e){}; window.__tws=null; } }")
            except Exception: pass
            try:
                m = fr.evaluate(f"""async () => {{
                  const mm = document.cookie.match(/_xsrf=([^;]+)/); const xsrf = mm ? mm[1] : '';
                  const r = await fetch('{BASE}/api/terminals/{name}', {{method:'DELETE', headers:{{'X-Xsrftoken': xsrf}}}});
                  return r.status;
                }}""")
            except Exception: pass


if __name__ == '__main__':
    main()

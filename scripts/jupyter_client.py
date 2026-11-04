# -*- coding: utf-8 -*-
"""JupyterLab 终端 API/CLI 客户端（脱离浏览器直连）
用法:
  python jupyter_client.py exec "命令" [超时秒]     # 在开发机执行命令并返回输出
  python jupyter_client.py upload "本地文件" "/远程路径"  # base64 分块上传
  python jupyter_client.py status                   # 终端与服务状态
"""
import base64, json, os, sys, time
import requests
import websocket

SESS_FILE = r'D:\Apps\本体bemodel医疗\data\jupyter_session.json'

def load():
    d = json.load(open(SESS_FILE, encoding='utf8'))
    return d['baseUrl'], d['cookie'], d.get('xsrf', '')

def hdr(cookie, xsrf, extra=None):
    h = {'Cookie': cookie}
    if xsrf: h['X-Xsrftoken'] = xsrf; h['X-CSRFToken'] = xsrf
    if extra: h.update(extra)
    return h

def api(base, cookie, xsrf, method, path, **kw):
    return requests.request(method, base + path, headers=hdr(cookie, xsrf), timeout=30, **kw)

def ws_url(base, name):
    base = base if base.endswith('/') else base + '/'
    return base.replace('https://', 'wss://').replace('http://', 'ws://') + f'terminals/websocket/{name}'

def connect_ws(base, cookie, name):
    ws = websocket.create_connection(ws_url(base, name), header={'Cookie': cookie, 'User-Agent': 'Mozilla/5.0'}, origin='https://discovery.intern-ai.org.cn', suppress_origin=False, timeout=10)
    return ws

def fresh_term(base, cookie, xsrf):
    r = api(base, cookie, xsrf, 'POST', '/api/terminals')
    r.raise_for_status()
    return r.json()['name']

def kill_term(base, cookie, xsrf, name):
    try: api(base, cookie, xsrf, 'DELETE', f'/api/terminals/{name}')
    except Exception: pass

def drain(ws, buf, timeout_s, marker):
    """结束条件：执行输出的 MK.._E_<pid>（$$ 展开），回显里的字面 $$ 不会误配。"""
    import re as _re
    ws.settimeout(0.5)
    t0 = time.time()
    began = False
    while time.time() - t0 < timeout_s:
        try:
            raw = ws.recv()
            try:
                arr = json.loads(raw)
                if isinstance(arr, list) and len(arr) == 2 and arr[0] in ('stdout', 'stderr', 'data'):
                    s = arr[1]
                else:
                    continue
            except Exception:
                continue
            buf.append(s)
            if not began and _re.search(marker + r"_B\d+", s):
                began = True
            elif began and _re.search(marker + r"_E\d+", s):
                return True
        except websocket.WebSocketTimeoutException:
            pass
        except Exception:
            return False
    return False

def exec_cmd(cmd, timeout=120):
    base, cookie, xsrf = load()
    name = fresh_term(base, cookie, xsrf)
    marker = 'MK' + str(int(time.time() * 1000))[-9:]
    ws = connect_ws(base, cookie, name)
    time.sleep(0.8)
    try:
        while True: ws.recv()
    except Exception: pass
    payload = f"export PS1=''; echo {marker}_B$$\n{cmd}\necho {marker}_E$$\n"
    ws.send(json.dumps(['stdin', payload]))
    buf = []
    done = drain(ws, buf, timeout, marker)
    try: ws.close()
    except Exception: pass
    kill_term(base, cookie, xsrf, name)
    text = ''.join(buf).replace('\r\n', '\n').replace('\r', '')
    # 从执行输出的 _B<pid> 标记行之后取，到 _E<pid> 标记之前
    import re as _re
    m = _re.search(marker + r"_B\d+", text)
    if m:
        nl = text.find('\n', m.end())
        text = text[nl + 1:] if nl >= 0 else ''
    j = _re.search(marker + r"_E\d+", text)
    rc = None
    if j:
        text = text[:j.start()]
    return text.strip(), rc, done

def upload(local, remote, chunk=60000):
    base, cookie, xsrf = load()
    data = open(local, 'rb').read()
    b64 = base64.b64encode(data).decode()
    # 分块写文件
    exec_cmd(f"rm -f {remote}.b64", 30)
    total = (len(b64) + chunk - 1) // chunk
    for i in range(0, len(b64), chunk):
        part = b64[i:i + chunk]
        out, rc, ok = exec_cmd(f"printf '%s' '{part}' >> {remote}.b64", 60)
        if not ok: return f'upload failed at chunk {i // chunk}/{total}'
        print(f'chunk {i // chunk + 1}/{total}', flush=True)
    out, rc, ok = exec_cmd(f"base64 -d {remote}.b64 > {remote} && rm -f {remote}.b64 && stat -c %s {remote}", 60)
    return f'uploaded {remote} → {out}'

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    op = sys.argv[1]
    if op == 'exec':
        out, rc, done = exec_cmd(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 120)
        print(out)
        if not done: print('[TIMEOUT]', file=sys.stderr)
        if rc not in (None, '0'): print(f'[exit {rc}]', file=sys.stderr)
    elif op == 'upload':
        print(upload(sys.argv[2], sys.argv[3]))
    elif op == 'status':
        base, cookie, xsrf = load()
        r = api(base, cookie, xsrf, 'GET', '/api/terminals')
        print(r.status_code, r.text[:200])
    else:
        print(__doc__)

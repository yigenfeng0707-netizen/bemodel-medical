# -*- coding: utf-8 -*-
"""本机 embedding 反向代理 v3（Jupyter 终端 WS 直连，持久会话）。

链路：平台 knowledge.js → http://localhost:11434/v1/embeddings（本进程）
      → 开发机 Jupyter 终端（持久 PTY，请求 b64 分块写入避开 4096 行限）
      → /root/oneshot2.py → 127.0.0.1:11434 embed_server（bge-m3 CUDA）
会话失效自动调 refresh_session.py 重铸 JWT；通道失败自动重建终端重试一次。
任何失败返回 502（平台 embed() 按空向量诚实降级走 FTS 关键词路）。
"""
import base64
import json
import os
import re
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(PROJ, "scripts"))
from jupyter_client import load, api, connect_ws, kill_term  # noqa: E402

LOG = open(os.path.join(PROJ, "data", "relay.log"), "ab", buffering=0)
CHUNK = 2800          # PTY 规范模式单行上限 4096，留余量
EXEC_TIMEOUT = 90

def log(msg):
    LOG.write((time.strftime("[%m-%d %H:%M:%S] ") + str(msg) + "\n").encode("utf8"))


class Executor:
    """持久 Jupyter 终端执行器：同一 PTY 跑多行命令，锁串行，断线自愈。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.ws = None
        self.name = None

    def _refresh_session(self):
        try:
            r = subprocess.run(
                [sys.executable, os.path.join(PROJ, "scripts", "refresh_session.py")],
                capture_output=True, text=True, timeout=150, cwd=PROJ)
            ok = "SESSION_SAVED" in (r.stdout or "")
            log("refresh_session ok=%s %s" % (ok, ((r.stdout or "") + (r.stderr or ""))[-160:]))
            return ok
        except Exception as e:
            log("refresh_session err: %s" % e)
            return False

    def _create_terminal(self):
        base, cookie, xsrf = load()
        r = api(base, cookie, xsrf, "POST", "/api/terminals")
        if r.status_code == 403 and self._refresh_session():
            base, cookie, xsrf = load()
            r = api(base, cookie, xsrf, "POST", "/api/terminals")
        r.raise_for_status()
        name = r.json()["name"]
        ws = connect_ws(base, cookie, name)
        time.sleep(0.8)
        try:
            ws.settimeout(0.3)
            while True:
                ws.recv()
        except Exception:
            pass
        self.name = name
        self.ws = ws
        log("terminal up: %s" % name)

    def close(self):
        try:
            if self.ws:
                self.ws.close()
        except Exception:
            pass
        try:
            if self.name:
                b, c, x = load()
                kill_term(b, c, x, self.name)
        except Exception:
            pass
        self.ws = None
        self.name = None

    def exec(self, lines, timeout=EXEC_TIMEOUT):
        """lines: 命令行列表（每行 < 4000 字符）。返回全部输出文本。失败重建重试一次。"""
        with self.lock:
            for attempt in (1, 2):
                try:
                    if self.ws is None:
                        self._create_terminal()
                    return self._drain_exec(lines, timeout)
                except Exception as e:
                    log("exec attempt %d fail: %s" % (attempt, str(e)[:120]))
                    self.close()
                    time.sleep(1.5)
            raise RuntimeError("terminal exec failed twice")

    def _drain_exec(self, lines, timeout):
        marker = "MK" + str(int(time.time() * 1000))[-9:]
        for ln in lines[:-1]:
            self.ws.send(json.dumps(["stdin", ln + "\n"]))
            time.sleep(0.12)
        self.ws.send(json.dumps(["stdin", lines[-1] + " ; echo " + marker + "_E$$\n"]))
        buf = []
        ws = self.ws
        ws.settimeout(0.5)
        t0 = time.time()
        while time.time() - t0 < timeout:
            try:
                raw = ws.recv()
            except Exception:
                if not getattr(ws, "connected", True):
                    raise RuntimeError("ws closed")
                continue
            try:
                arr = json.loads(raw)
                if isinstance(arr, list) and len(arr) == 2 and arr[0] in ("stdout", "stderr"):
                    s = arr[1]
                    buf.append(s)
                    if re.search(marker + r"_E\d+", s):
                        return "".join(buf).replace("\r\n", "\n").replace("\r", "")
            except json.JSONDecodeError:
                continue
        raise RuntimeError("exec timeout")


EX = Executor()


def ensure_oneshot2():
    """确保远端 /root/oneshot2.py 在位且可解析（幂等，启动时调用）。"""
    src = open(os.path.join(PROJ, "scripts", "oneshot2.py"), "rb").read()
    b64 = base64.b64encode(src).decode()
    assert len(b64) <= CHUNK, "oneshot2.py b64 too big for one chunk"
    out = EX.exec([
        "rm -f /root/oneshot2.py",
        "printf '%s' '" + b64 + "' > /root/oneshot2.py.b64",
        "base64 -d /root/oneshot2.py.b64 > /root/oneshot2.py && rm -f /root/oneshot2.py.b64 && "
        "python3 -c \"import ast;ast.parse(open('/root/oneshot2.py').read())\" && echo ONESHOT2_OK",
    ], 60)
    if "ONESHOT2_OK" not in out:
        raise RuntimeError("oneshot2 upload failed: " + out[-150:])
    log("oneshot2 uploaded")


def remote_embed(texts, model, timeout=EXEC_TIMEOUT):
    body = json.dumps({"input": texts, "model": model}).encode("utf8")
    req = (b"POST /embeddings HTTP/1.0\r\nContent-Type: application/json\r\n"
           + b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
    b64 = base64.b64encode(req).decode()
    lines = ["rm -f /root/relay_req.b64"]
    for i in range(0, len(b64), CHUNK):
        lines.append("printf '%s' '" + b64[i:i + CHUNK] + "' >> /root/relay_req.b64")
    # 响应落盘 → b64 → fold 成 2048 短行：61KB 单行长输出会被终端 scrollback 丢头，短行安全
    lines.append("python3 /root/oneshot2.py /root/relay_req.b64 > /root/relay_resp.json && "
                 "base64 -w0 /root/relay_resp.json | fold -w 2048 && echo RDONE")
    out = EX.exec(lines, timeout)
    # 收纯 b64 行；RDONE 可能与最后一条 fold 行粘行（fold 末行无尾换行时），先剥离
    b64_lines = []
    for ln in out.split("\n"):
        s = ln.strip()
        if s.endswith("RDONE"):
            s = s[:-5].strip()
        if len(s) > 4 and re.fullmatch(r"[A-Za-z0-9+/=]+", s):
            b64_lines.append(s)
    if not b64_lines:
        raise RuntimeError("no b64 in output: " + out[-120:])
    joined = "".join(b64_lines)
    log("b64 lines=%d joined=%d" % (len(b64_lines), len(joined)))
    resp_text = base64.b64decode(joined).decode("utf8", "replace")
    idx = resp_text.find('{"object"')
    if idx >= 0:
        try:
            obj, _ = json.JSONDecoder().raw_decode(resp_text[idx:])
            if "data" in obj:
                return obj
            if "error" in obj:
                raise RuntimeError("remote error: " + str(obj["error"])[:120])
        except RuntimeError:
            raise
        except Exception:
            pass
    raise RuntimeError("no json in resp: " + resp_text[-120:])


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        log("%s %s" % (self.address_string(), fmt % args))

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/v1/models"):
            self._json(200, {"object": "list", "data": [{"id": "bge-m3", "object": "model"}]})
        elif self.path.startswith("/health"):
            ok = EX.ws is not None and getattr(EX.ws, "connected", False)
            self._json(200, {"ok": ok, "terminal": EX.name, "mode": "jupyter-terminal-relay"})
        else:
            self._json(200, {"ok": True, "service": "embedding-relay", "target": "dev-machine bge-m3"})

    def do_POST(self):
        if not self.path.rstrip("/").endswith("/embeddings"):
            self._json(404, {"error": "not found"})
            return
        n = int(self.headers.get("Content-Length", 0) or 0)
        try:
            req = json.loads(self.rfile.read(n))
        except Exception:
            self._json(400, {"error": "bad json"})
            return
        texts = req.get("input")
        if isinstance(texts, str):
            texts = [texts]
        if not texts or not isinstance(texts, list):
            self._json(400, {"error": "input must be string or list"})
            return
        model = req.get("model") or "bge-m3"
        t0 = time.time()
        try:
            data = remote_embed([str(t) for t in texts], model)
            log("embed ok n=%d dims=%d %.1fs" % (len(texts), len(data["data"][0]["embedding"]), time.time() - t0))
            self._json(200, data)
        except Exception as e:
            log("embed fail: %s" % str(e)[:150])
            self._json(502, {"error": "relay unavailable: " + str(e)[:120]})


def main():
    port = 11434
    log("relay starting on 127.0.0.1:%d" % port)
    ensure_oneshot2()
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    log("relay ready")
    print("relay ready on http://127.0.0.1:%d (Ctrl+C stop)" % port, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        EX.close()
        log("relay stopped")


if __name__ == "__main__":
    main()

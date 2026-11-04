# -*- coding: utf-8 -*-
"""容器内一次性请求 v2：argv[1]=base64 请求文件 → POST 127.0.0.1:11434 → stdout 仅输出 HTTP body(JSON)。
请求体需含 Content-Length 头（embed_server 按 Content-Length 读）。"""
import sys, base64, socket

data = open(sys.argv[1]).read().strip()
req = base64.b64decode(data)
s = socket.create_connection(("127.0.0.1", 11434), timeout=60)
s.sendall(req)
resp = b""
while True:
    d = s.recv(65536)
    if not d:
        break
    resp += d
s.close()
i = resp.find(b"\r\n\r\n")
body = resp[i + 4:] if i >= 0 else resp
sys.stdout.write(body.decode("utf8", "replace"))

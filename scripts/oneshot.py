# -*- coding: utf-8 -*-
"""容器内一次性请求脚本：argv[1] 收 base64 请求文件 → POST 11434 → stdout 输出 base64 响应。"""
import sys
import base64
import socket

data = open(sys.argv[1]).read().strip()
req = base64.b64decode(data)
s = socket.create_connection(("127.0.0.1", 11434))
s.sendall(req)
resp = b""
while True:
    d = s.recv(65536)
    if not d:
        break
    resp += d
s.close()
sys.stdout.write(base64.b64encode(resp).decode())

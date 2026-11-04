# -*- coding: utf-8 -*-
"""刷新书生开发机会话：重载控制台页（重铸 notebook_access_jwt）→ 提取全量 cookie → 写 jupyter_session.json。
供 relay_server.py 在 403 时子进程调用；SESSION_SAVED 在 stdout 即成功。
"""
import json, sys, time
from playwright.sync_api import sync_playwright

NB = "https://discovery-notebook-p.intern-ai.org.cn/notebook/292100386/nb-4353529c2d4a994d3680291617bc1b65"
CONSOLE = "https://discovery.intern-ai.org.cn/compute/dev-machine/inside/4564/nb-4353529c2d4a994d3680291617bc1b65"
LAB = NB + "/notebook/lab"
SESS = "data/jupyter_session.json"

def main():
    with sync_playwright() as p:
        b = p.chromium.connect_over_cdp("http://127.0.0.1:9223", timeout=15000)
        ctx = b.contexts[0]
        con = next((x for x in ctx.pages if "/inside/" in x.url), None)
        if con is not None:
            try:
                con.reload(timeout=45000, wait_until="domcontentloaded")
                time.sleep(6)
            except Exception as e:
                print("console reload warn:", str(e)[:80])
        pg = next((x for x in ctx.pages if x.url.startswith(LAB)), None)
        if pg is None:
            pg = ctx.new_page()
            pg.goto(LAB, timeout=60000, wait_until="domcontentloaded")
        time.sleep(4)
        ck = pg.evaluate("() => document.cookie")
        if "_xsrf=" not in ck:
            print("NO_XSRF")
            sys.exit(1)
        jar = {c['name']: c['value'] for c in ctx.cookies([LAB])}
        if "notebook_access_jwt" not in jar:
            print("NO_JWT")
            sys.exit(1)
        d = json.load(open(SESS, encoding="utf8"))
        d["cookie"] = "; ".join(f"{k}={v}" for k, v in jar.items())
        d["xsrf"] = jar["_xsrf"]
        d["extractedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
        json.dump(d, open(SESS, "w", encoding="utf8"), ensure_ascii=False, indent=2)
        print("SESSION_SAVED jwt_iat_window:", d["extractedAt"])

if __name__ == "__main__":
    main()

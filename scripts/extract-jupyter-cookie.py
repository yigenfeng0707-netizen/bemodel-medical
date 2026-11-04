# 从克隆 Chrome（CDP 9223）提取 Jupyter 会话 Cookie → data/jupyter_session.json
import json, os, sys, time
from playwright.sync_api import sync_playwright

OUT = r'D:\Apps\本体bemodel医疗\data\jupyter_session.json'
def main():
    with sync_playwright() as p:
        b = p.chromium.connect_over_cdp("http://127.0.0.1:9223")
        ctx = b.contexts[0]
        cookies = []
        for c in ctx.cookies(["https://discovery-notebook-p.intern-ai.org.cn", "https://discovery.intern-ai.org.cn"]):
            if c['name'] in ('_xsrf', 'jupyter_user_session', 'jupyter-hub-token', '_xsrf_form_token') or 'jupyter' in c['name'].lower() or 'session' in c['name'].lower() or c['name'] == '_xsrf':
                cookies.append(c)
        # 保险：全量带上（header 里拼全部）
        allc = ctx.cookies(["https://discovery-notebook-p.intern-ai.org.cn"])
        cookie_header = '; '.join(f"{c['name']}={c['value']}" for c in allc)
        xsrf = next((c['value'] for c in allc if c['name'] == '_xsrf'), '')
        data = {
            'baseUrl': 'https://discovery-notebook-p.intern-ai.org.cn/notebook/292100386/nb-4353529c2d4a994d3680291617bc1b65/notebook',
            'cookie': cookie_header,
            'xsrf': xsrf,
            'extractedAt': time.strftime('%Y-%m-%d %H:%M:%S'),
        }
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        json.dump(data, open(OUT, 'w', encoding='utf8'), ensure_ascii=False, indent=2)
        print('saved', OUT, '| cookie len', len(cookie_header), '| xsrf', bool(xsrf))

if __name__ == '__main__':
    main()

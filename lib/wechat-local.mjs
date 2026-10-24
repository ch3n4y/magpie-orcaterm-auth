/**
 * 微信扫码登录的「自动接收回调」实现。
 *
 * 关键点：不能直接把 open.weixin.qq.com/connect/qrconnect 放进 iframe ——
 * 那个页面在扫码后默认做 **顶层跳转**，会把宿主页面整个换掉，postMessage 也就收不到了。
 *
 * 正确做法是用官方 wxLogin.js 并设 `self_redirect: true`：回跳发生在它创建的内层
 * iframe 里，OrcaTerm 的回调页 /oauth/wechat/bridge 加载在该 iframe 中，
 * 它的 `window.parent` 就是我们的页面，于是 postMessage 能收到。
 *
 * 远程部署（magpie 装在服务器上、用浏览器访问）时：插件在服务器上监听 127.0.0.1，
 * 用户浏览器够不到。此时把端口固定并用 SSH 隧道即可：
 *     ssh -L 14300:127.0.0.1:14300 <server>
 *     # 然后浏览器打开 http://127.0.0.1:14300/login
 * 端口/基址可用 ORCATERM_CAPTURE_PORT / ORCATERM_CAPTURE_BASE 覆盖。
 */
import http from "node:http";

const DEFAULT_PORT = 14300;

const PAGE = ({ appid, redirectUri, state }) => `<!doctype html>
<html lang="zh"><meta charset="utf-8">
<title>OrcaTerm 微信登录</title>
<style>
  html,body{margin:0;height:100%;background:#0b0d10;color:#e6e6e6;
    font:14px/1.6 -apple-system,system-ui,"PingFang SC",sans-serif}
  #wrap{display:flex;align-items:center;justify-content:center;height:100%}
  #done{display:none;align-items:center;justify-content:center;height:100%;text-align:center}
  .err{color:#ff8a8a}
</style>
<div id="wrap"><div id="wxqr"></div></div>
<div id="done"></div>
<script src="https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js"></script>
<script>
  const APPID = ${JSON.stringify(appid)};
  const REDIRECT = ${JSON.stringify(redirectUri)};
  const STATE = ${JSON.stringify(state)};

  // self_redirect: true —— 回调留在内层 iframe，宿主页面不被替换
  new WxLogin({
    self_redirect: true,
    id: 'wxqr',
    appid: APPID,
    scope: 'snsapi_login',
    redirect_uri: encodeURIComponent(REDIRECT),
    state: STATE,
    style: 'black',
    href: '',
  });

  function done(text, isErr) {
    document.getElementById('wrap').style.display = 'none';
    const d = document.getElementById('done');
    d.className = isErr ? 'err' : '';
    d.textContent = text;
    d.style.display = 'flex';
  }

  window.addEventListener('message', async (e) => {
    const d = e.data;
    if (!d || d.type !== 'wechat-oauth-callback') return;
    try {
      const r = await fetch('/cb', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(d),
      });
      const j = await r.json();
      done(j.ok ? '登录成功，可以关闭这个页面了' : ('登录失败：' + (j.error || '未知错误')), !j.ok);
    } catch (err) {
      done('登录失败：' + err, true);
    }
  });
</script>
</html>`;

/**
 * 立刻返回句柄：`ready` 给出本地页面地址，`wait` 等回调里的 code。
 * @returns {{ready: Promise<string>, wait: Promise<{code:string,state:string}>, close: ()=>void}}
 */
export function createLocalCapture({ appid, redirectUri, state, timeoutMs = 300_000 }) {
  let resolveReady;
  let resolveWait;
  let rejectWait;
  let settled = false;

  const ready = new Promise((r) => {
    resolveReady = r;
  });
  const wait = new Promise((res, rej) => {
    resolveWait = res;
    rejectWait = rej;
  });
  wait.catch(() => {});

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/login")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE({ appid, redirectUri, state }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/cb") {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
        if (raw.length > 64 * 1024) req.destroy();
      });
      req.on("end", () => {
        let body = {};
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          /* 忽略 */
        }
        const code = body.code;
        const gotState = body.state || state;
        const err = body.error;
        const ok = Boolean(code) && !err;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(ok ? { ok: true } : { ok: false, error: err || "没有 code" }));
        if (!ok || settled) return;
        settled = true;
        clearTimeout(timer);
        resolveWait({ code, state: gotState });
      });
      return;
    }

    res.writeHead(404).end();
  });

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    close();
    rejectWait(new Error("等待扫码超时，请重试"));
  }, timeoutMs);

  function close() {
    clearTimeout(timer);
    try {
      server.close();
    } catch {
      /* 忽略 */
    }
  }

  const wanted = Number(process.env.ORCATERM_CAPTURE_PORT) || DEFAULT_PORT;
  const base = process.env.ORCATERM_CAPTURE_BASE || "";
  const host = process.env.ORCATERM_CAPTURE_HOST || "127.0.0.1";

  const tryListen = (port) => {
    const onErr = (e) => {
      if (e.code === "EADDRINUSE" && port !== 0) {
        tryListen(0);
        return;
      }
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectWait(e);
      }
    };
    server.once("error", onErr);
    server.listen(port, host, () => {
      server.removeListener("error", onErr);
      const actual = server.address().port;
      const shown = host === "0.0.0.0" ? "127.0.0.1" : host;
      resolveReady(`${base || `http://${shown}:${actual}`}/login`);
    });
  };

  tryListen(wanted);

  return { ready, wait, close };
}

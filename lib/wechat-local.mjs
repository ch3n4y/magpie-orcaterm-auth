/**
 * 微信扫码登录的「自动接收回调」实现。
 *
 * 可行性依据：`https://open.weixin.qq.com/connect/qrconnect` 没有
 * X-Frame-Options / CSP frame-ancestors，可以内嵌；OrcaTerm 的回调页
 * `https://orcaterm.com/oauth/wechat/bridge` 会把结果 postMessage 给父窗口
 * （{type:'wechat-oauth-callback', code, state}）—— OrcaTerm 网页版正是这么接的。
 *
 * 于是插件在本地起一个一次性页面：
 *   127.0.0.1:<随机端口>/login  内嵌 qrconnect，监听 message，拿到 code 后 POST 回本地
 * 用户只需扫码，不用复制 URL，也就没有「state 被抢先消费」的窗口。
 */
import http from "node:http";

const PAGE = (qrUrl) => `<!doctype html>
<html lang="zh"><meta charset="utf-8">
<title>OrcaTerm 微信登录</title>
<style>
  html,body{margin:0;height:100%;background:#0b0d10;color:#e6e6e6;
    font:14px/1.6 -apple-system,system-ui,"PingFang SC",sans-serif}
  iframe{border:0;width:100%;height:100%;display:block}
  .done,.err{display:flex;align-items:center;justify-content:center;height:100%;text-align:center}
  .err{color:#ff8a8a}
</style>
<iframe id="f"></iframe>
<script>
  const qr = ${JSON.stringify(qrUrl)};
  document.getElementById('f').src = qr;

  function done(text, isErr) {
    document.body.innerHTML = '';
    const d = document.createElement('div');
    d.className = isErr ? 'err' : 'done';
    d.textContent = text;
    document.body.appendChild(d);
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
export function createLocalCapture({ qrUrl, state, timeoutMs = 300_000 }) {
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
  // 避免无人 await 时的 unhandled rejection
  wait.catch(() => {});

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/login")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE(qrUrl));
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
    rejectWait(new Error("等待扫码超时，请重试，或改用「微信扫码（手动粘贴回调）」"));
  }, timeoutMs);

  function close() {
    clearTimeout(timer);
    try {
      server.close();
    } catch {
      /* 忽略 */
    }
  }

  server.on("error", (e) => {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      rejectWait(e);
    }
  });

  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    resolveReady(`http://127.0.0.1:${port}/login`);
  });

  return { ready, wait, close };
}

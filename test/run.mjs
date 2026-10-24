/**
 * 本地自测：模拟 Magpie 网关把 chat/completions 交给插件，打到真实上游。
 *
 *   node test/run.mjs auto                     # 登录：自动读取本机登录态
 *   node test/run.mjs stream "问题" [模型]      # 流式
 *   node test/run.mjs nostream "问题"           # 非流式
 *   node test/run.mjs pacer                    # 限流器单测（不发网络请求）
 *   node test/run.mjs wechat                   # 微信扫码：取 config 并打印二维码 URL
 *   node test/run.mjs wechat "<回调URL|code>"    # 微信扫码：用粘贴内容换 token 并验证
 */
import { OrcaTermAuthPlugin } from "../index.mjs";
import { Pacer } from "../lib/rate-limit.mjs";
import {
  exchangeCode,
  parseCallbackInput,
  startWechatLogin,
} from "../lib/wechat-oauth.mjs";
const [cmd = "auto", ...args] = process.argv.slice(2);

async function makeLoader() {
  const hooks = await OrcaTermAuthPlugin({ client: {} }, { rateLimitPerMinute: 10 });
  const localMethod = hooks.auth.methods.find((m) =>
    String(m.label).includes("自动读取"),
  );
  const res = await localMethod.authorize();
  if (res.type !== "success") throw new Error(`登录失败: ${res.error}`);
  console.log(`登录成功: userId=${res.metadata.userId} token=${res.key.slice(0, 18)}…`);
  const loader = await hooks.auth.loader(async () => ({
    type: "api",
    key: res.key,
    metadata: res.metadata,
  }));
  return { hooks, loader };
}

function reqBody(text, model, stream) {
  return {
    model,
    stream,
    messages: [
      { role: "system", content: "回答尽量简短。" },
      { role: "user", content: text },
    ],
  };
}

async function run() {
  if (cmd === "pacer") {
    const p = new Pacer({ limit: 2, windowMs: 600 });
    const t0 = Date.now();
    for (let i = 0; i < 5; i += 1) {
      await p.acquire();
      console.log(`  #${i + 1} 拿到许可 @ +${Date.now() - t0}ms`);
    }
    console.log("pacer ok（每 600ms 窗口放 2 个）");
    return;
  }

  if (cmd === "wechat") {
    const login = await startWechatLogin();
    console.log("state   :", login.state);
    console.log("二维码 URL:\n" + login.url);
    console.log("\n" + login.instructions + "\n");
    if (!args[0]) return;
    const { code, state } = parseCallbackInput(args[0], login.state);
    const r = await exchangeCode({ code, state });
    console.log(
      `登录成功: userId=${r.userId} nick=${r.providerUsername} ` +
        `token=${r.accessToken.slice(0, 18)}… expiresIn=${r.expiresIn}s`,
    );
    return;
  }

  const { loader } = await makeLoader();

  if (cmd === "nostream") {
    const res = await loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody(args[0] ?? "你好", args[1] ?? "deepseek-v4-flash", false)),
    });
    console.log("status:", res.status);
    console.log(JSON.stringify(await res.json(), null, 2).slice(0, 900));
    return;
  }

  // 默认：流式
  const body = reqBody(
    args[0] ?? "服务器 CPU 占用高怎么排查？",
    args[1] ?? "deepseek-v4-flash",
    true,
  );
  const res = await loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log("status:", res.status, res.headers.get("content-type"));
  if (!res.ok) {
    console.log(await res.text());
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let answer = "";
  let reasoning = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const block of parts) {
      const payload = block.replace(/^data:\s*/, "").trim();
      if (!payload || payload === "[DONE]") continue;
      const obj = JSON.parse(payload);
      if (obj.error) {
        console.log("UPSTREAM ERROR:", obj.error.message);
        continue;
      }
      const d = obj.choices?.[0]?.delta ?? {};
      if (d.content) answer += d.content;
      if (d.reasoning_content) reasoning += d.reasoning_content;
    }
  }
  if (reasoning) console.log("---- reasoning ----\n" + reasoning.slice(0, 300));
  console.log("---- answer ----\n" + (answer || "(空)"));
}

run().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});

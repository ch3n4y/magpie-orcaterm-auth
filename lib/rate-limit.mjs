/**
 * 上游风控：/assistant/chat 有每账号的滑动窗口限流。
 *
 * 实测（2026-10）：
 *   响应头  X-RateLimit-Limit: 10 / X-RateLimit-Remaining: N / X-RateLimit-Reset: 60
 *   打满后  HTTP 200 + application/json
 *           {"code":429,"data":null,"message":"Rate limit exceeded: chat-rpm"}
 *
 * 这里做两件事：
 *   1. 主动控速（滑动窗口），别等被限；
 *   2. 被动退避（收到 429 后整段时间冷却，再指数退避重试）。
 */

const pacers = new Map();

export class Pacer {
  constructor({ limit = 10, windowMs = 60_000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = [];
    this.cooldownUntil = 0;
    this.chain = Promise.resolve();
  }

  prune(now) {
    const cut = now - this.windowMs;
    while (this.hits.length && this.hits[0] <= cut) this.hits.shift();
  }

  /** 阻塞直到拿到一个发送许可；串行化避免并发穿透 */
  acquire(signal) {
    const run = async () => {
      for (;;) {
        if (signal?.aborted) throw new Error("aborted");
        const now = Date.now();
        if (now < this.cooldownUntil) {
          await sleep(Math.min(this.cooldownUntil - now, 5_000), signal);
          continue;
        }
        this.prune(now);
        if (this.hits.length < this.limit) {
          this.hits.push(now);
          return;
        }
        const wait = this.hits[0] + this.windowMs - now + 50;
        await sleep(Math.min(Math.max(wait, 50), 5_000), signal);
      }
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  /** 收到 429 时调用：整账号冷却，同时清空窗口计数 */
  note429(retryAfterSec) {
    const ms = Math.max(1, Number(retryAfterSec) || 60) * 1000;
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + ms);
    this.hits = [];
  }

  /** 用响应头校准（成功响应也会带 X-RateLimit-*） */
  syncFromHeaders(headers) {
    if (!headers) return;
    const get = (k) =>
      typeof headers.get === "function" ? headers.get(k) : headers[k];
    const limit = Number(get("x-ratelimit-limit"));
    const remaining = Number(get("x-ratelimit-remaining"));
    const reset = Number(get("x-ratelimit-reset"));
    if (Number.isFinite(limit) && limit > 0) this.limit = limit;
    if (Number.isFinite(remaining) && Number.isFinite(limit) && remaining <= 0) {
      this.note429(Number.isFinite(reset) ? reset : 60);
    }
  }

  snapshot() {
    this.prune(Date.now());
    return {
      limit: this.limit,
      used: this.hits.length,
      windowMs: this.windowMs,
      cooldownMs: Math.max(0, this.cooldownUntil - Date.now()),
    };
  }
}

export function pacerFor(key = "default", opts) {
  let p = pacers.get(key);
  if (!p) {
    p = new Pacer(opts);
    pacers.set(key, p);
  }
  return p;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

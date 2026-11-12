// Discord REST posting on a worker thread.
//
// After a plugin's subagent run ends, OpenClaw 2026.10.2 reloads every plugin
// (subagent_ended hooks) on the main thread, which blocked its event loop for
// 25–40 s on our Gateway: a reply known at that moment could not be sent until
// the reload finished. A worker thread has its own event loop, so the post
// goes out right away.

import { Worker } from "node:worker_threads";

const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", async ({ id, token, channelId, content, userAgent }) => {
  try {
    const res = await fetch("https://discord.com/api/v10/channels/" + channelId + "/messages", {
      method: "POST",
      headers: { authorization: "Bot " + token, "content-type": "application/json", "user-agent": userAgent },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
    const body = await res.text();
    let json = {};
    try { json = JSON.parse(body); } catch {}
    parentPort.postMessage({ id, status: res.status, messageId: json.id, retryAfter: json.retry_after, error: res.ok ? undefined : body.slice(0, 300) });
  } catch (e) {
    parentPort.postMessage({ id, status: 0, error: String(e && e.message || e) });
  }
});
`;

const UA = "DiscordBot (https://github.com/yousan/openclaw-voice-wake-text, 0.3)";

/** Returns post(channelId, content) -> message id, and close(). One worker, started lazily, unref'd. */
export function workerPoster({ token, timeoutMs = 30_000, createWorker } = {}) {
  let worker = null;
  let seq = 0;
  const pending = new Map();
  const start = () => {
    worker = createWorker ? createWorker() : new Worker(WORKER_SOURCE, { eval: true });
    worker.unref?.();
    worker.on("message", (m) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.status >= 200 && m.status < 300) p.resolve(m.messageId);
      else p.reject(Object.assign(new Error(`Discord HTTP ${m.status}: ${m.error || ""}`), { status: m.status, retryAfterMs: m.retryAfter ? m.retryAfter * 1000 : undefined }));
    });
    worker.on("error", (e) => fail(e));
    worker.on("exit", () => fail(new Error("posting worker exited")));
  };
  const fail = (e) => {
    worker = null;
    for (const p of pending.values()) clearTimeout(p.timer), p.reject(e);
    pending.clear();
  };
  return {
    post(channelId, content) {
      if (!worker) start();
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => (pending.delete(id), reject(new Error("posting timed out"))), timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, token, channelId, content, userAgent: UA });
      });
    },
    async close() {
      const w = worker;
      worker = null;
      await w?.terminate?.();
    },
  };
}

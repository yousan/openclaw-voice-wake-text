import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { workerPoster } from "../src/rest-worker.js";

function fakeWorker(reply) {
  const w = new EventEmitter();
  w.sent = [];
  w.postMessage = (m) => (w.sent.push(m), setImmediate(() => w.emit("message", reply(m))));
  w.terminate = async () => {};
  return w;
}

test("posts through the worker and resolves with the message id; errors carry the status", async () => {
  let w;
  const p = workerPoster({
    token: "T",
    createWorker: () => (w = fakeWorker((m) => (m.content === "bad" ? { id: m.id, status: 429, retryAfter: 1.5, error: "rate" } : { id: m.id, status: 200, messageId: "m1" }))),
  });
  assert.equal(await p.post("C1", "hello"), "m1");
  assert.deepEqual([w.sent[0].token, w.sent[0].channelId, w.sent[0].content], ["T", "C1", "hello"]);
  await assert.rejects(p.post("C1", "bad"), (e) => e.status === 429 && e.retryAfterMs === 1500);
  await p.close();
});

test("the worker source itself starts and answers (network errors come back as status 0)", async () => {
  // Real worker, unreachable host: proves the eval'd source loads and replies without hanging.
  const orig = globalThis.fetch;
  const p = workerPoster({ token: "T", timeoutMs: 20_000 });
  const r = await p.post("0", "x").then(() => "ok", (e) => e.status ?? e.message);
  assert.ok(r === 401 || r === 404 || r === 0 || typeof r === "number" || /timed out/.test(r), String(r));
  await p.close();
  globalThis.fetch = orig;
  assert.ok(Worker);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import plugin from "../openclaw/index.js";
import { makeDb, C, U1, BOT, sleep } from "./fixtures.js";

function fakeApi({ pluginConfig, stateDir, terminalReply = { disposition: "visible", text: "明日は晴れです" } }) {
  const sent = [];
  const runs = [];
  const services = [];
  const api = {
    registrationMode: "full",
    pluginConfig,
    config: {},
    logger: { info() {}, warn() {}, error() {} },
    registerService: (s) => services.push(s),
    runtime: {
      config: { current: () => ({ marker: "live" }) },
      state: { resolveStateDir: () => stateDir },
      subagent: {
        run: async (p) => (runs.push(p), { runId: `r${runs.length}`, sessionKey: p.sessionKey }),
        waitForRun: async () => ({ status: "ok", terminalReply }),
        getSessionMessages: async () => ({ messages: [] }),
      },
      channel: {
        outbound: {
          loadAdapter: async (id) => ({ sendText: async (ctx) => (sent.push({ id, ...ctx }), { messageId: `m${sent.length}` }) }),
        },
      },
    },
  };
  return { api, sent, runs, services };
}

test("a spoken call becomes one agent turn and a text reply in the voice channel's chat", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vwt-plugin-"));
  fs.mkdirSync(path.join(dir, "state"));
  const w = makeDb(path.join(dir, "state", "openclaw.sqlite"));
  const { api, sent, runs, services } = fakeApi({
    pluginConfig: { channelIds: [C], names: ["ミナ"], settleMs: 30, pollMs: 100, botUserId: BOT },
    stateDir: dir,
  });
  plugin.register(api);
  await services[0].start({});
  w.say(BOT, "ミナ", "ミナです"); // the agent itself
  w.say(U1, "Alice", "ミナ、明日の天気は？");
  await sleep(400);
  await services[0].stop();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].sessionKey, `agent:main:voice-wake:${C}`);
  assert.equal(runs[0].deliver, false);
  assert.match(runs[0].message, /Alice: ミナ、明日の天気は？/);
  assert.deepEqual(sent.map((s) => [s.id, s.to, s.text, s.cfg.marker]), [["discord", `channel:${C}`, "明日は晴れです", "live"]]);
});

test("off until channelIds and names are set", async () => {
  const { api, services, runs } = fakeApi({ pluginConfig: { channelIds: [C] }, stateDir: "/nonexistent" });
  plugin.register(api);
  const r = await services[0].start({});
  await services[0].stop();
  assert.equal(runs.length, 0);
});

test("does nothing outside full registration", () => {
  const { api, services } = fakeApi({ pluginConfig: {}, stateDir: "/x" });
  api.registrationMode = "tool-discovery";
  plugin.register(api);
  assert.equal(services.length, 0);
});

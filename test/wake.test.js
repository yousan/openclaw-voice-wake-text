import test from "node:test";
import assert from "node:assert/strict";
import { WakeEngine, callsName, normalize } from "../src/wake.js";
import { C, G, OTHER, U1, U2, BOT, sleep } from "./fixtures.js";

let n = 0;
const u = (userId, speaker, text, channelId = C) => ({ key: `s#${n++}`, guildId: G, channelId, userId, speaker, text, at: Date.now() });

function setup(over = {}) {
  const asks = [];
  const posts = [];
  const engine = new WakeEngine({
    config: { channelIds: [C], names: ["ミナ", "みな", "ねえミナ"], ignoreWords: ["みなさん"], settleMs: 40, maxWaitMs: 200, cooldownMs: 0, ...over.config },
    isPerson: (x) => x.userId !== BOT,
    ask: over.ask || (async (req) => (asks.push(req), ("reply" in over ? over.reply : "はい、ミナです"))),
    post: async (ch, text) => posts.push([ch, text]),
  });
  return { engine, asks, posts };
}

test("name matching ignores width, case, spaces, punctuation and listed words", () => {
  assert.equal(normalize("ﾐﾅ、 Hello!"), "ミナhello");
  assert.ok(callsName("ねえ、ミナ。今日は何曜日？", ["ミナ"]));
  assert.ok(callsName("hey MINA what's up", ["mina"]));
  assert.ok(!callsName("みなさんこんにちは", ["みな"], ["みなさん"]));
  assert.ok(callsName("みなさん、みな聞いて", ["みな"], ["みなさん"]));
  assert.ok(!callsName("今日は晴れ", ["ミナ"]));
});

test("answers a call with the conversation around it, once, in the room's chat", async () => {
  const { engine, asks, posts } = setup();
  engine.push(u(U2, "Bob", "週末どうする？"));
  const call = u(U1, "Alice", "ミナ、");
  engine.push(call);
  engine.push(call); // the same row seen again
  engine.push(u(U1, "Alice", "明日の天気は？"));
  await sleep(150);
  await engine.stop();
  assert.equal(asks.length, 1);
  assert.match(asks[0].prompt, /Bob: 週末どうする？/);
  assert.match(asks[0].prompt, /▶ \[[0-9:]+\] Alice: ミナ、/);
  assert.match(asks[0].prompt, /Alice: 明日の天気は？/);
  assert.deepEqual(posts, [[C, "はい、ミナです"]]);
});

test("no reply without the name, from bots, or in other rooms", async () => {
  const { engine, asks, posts } = setup();
  engine.push(u(U1, "Alice", "今日は晴れだね"));
  engine.push(u(BOT, "OtherBot", "ミナ、聞こえる？"));
  engine.push(u(U1, "Alice", "ミナ", OTHER));
  await sleep(120);
  await engine.stop();
  assert.equal(asks.length, 0);
  assert.equal(posts.length, 0);
});

test("NO_REPLY and empty answers post nothing", async () => {
  for (const reply of ["NO_REPLY", "", null]) {
    const { engine, posts } = setup({ reply });
    engine.push(u(U1, "Alice", "ミナがさ、昨日"));
    await sleep(100);
    await engine.stop();
    assert.equal(posts.length, 0);
  }
});

test("calls while answering collapse into one more answer", async () => {
  let release;
  const asks = [];
  const { engine, posts } = setup({
    ask: async (req) => {
      asks.push(req);
      if (asks.length === 1) await new Promise((r) => (release = r));
      return `answer ${asks.length}`;
    },
  });
  engine.push(u(U1, "Alice", "ミナ、一つ目"));
  await sleep(80); // first turn is running
  engine.push(u(U1, "Alice", "ミナ、二つ目"));
  engine.push(u(U2, "Bob", "ミナ、三つ目"));
  engine.push(u(U2, "Bob", "ねえミナ、四つ目"));
  release();
  await sleep(200);
  await engine.stop();
  assert.equal(asks.length, 2);
  assert.match(asks[1].prompt, /四つ目/);
  assert.doesNotMatch(asks[1].prompt, /▶ .*一つ目/);
  assert.deepEqual(posts.map((p) => p[1]), ["answer 1", "answer 2"]);
});

test("a call inside the cooldown waits, and is dropped if the last answer already covered it", async () => {
  const { engine, asks } = setup({ config: { cooldownMs: 150, settleMs: 30 } });
  engine.push(u(U1, "Alice", "ミナ、一つ目"));
  await sleep(60);
  engine.push(u(U1, "Alice", "ミナ、まだいる？"));
  await sleep(40);
  assert.equal(asks.length, 1);
  await sleep(200);
  await engine.stop();
  assert.equal(asks.length, 2);
});

test("postTranscript posts the lines before the reply", async () => {
  const { engine, posts } = setup({ config: { postTranscript: true, transcriptFlushMs: 10_000 } });
  engine.push(u(U2, "Bob*", "@everyone 聞いて"));
  engine.push(u(U1, "Alice", "ミナ、今何時？"));
  await sleep(100);
  await engine.stop();
  assert.deepEqual(posts.map((p) => p[1]), ["**Bob\\***: @​everyone 聞いて\n**Alice**: ミナ、今何時？", "はい、ミナです"]);
});

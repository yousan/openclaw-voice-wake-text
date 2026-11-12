import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UtteranceFollower, sqliteReady } from "../src/store.js";
import { makeDb, C, G, U1 } from "./fixtures.js";

test("reads only rows added after start, read-only, with room and speaker", async () => {
  await sqliteReady;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vwt-store-"));
  const file = path.join(dir, "openclaw.sqlite");
  const w = makeDb(file);
  w.say(U1, "Alice", "old line");
  const got = [];
  const f = new UtteranceFollower({ file, onUtterance: (u) => got.push(u) });
  f.poll();
  assert.equal(got.length, 0);
  w.say(U1, "Alice", "Mina, hello");
  w.say(U1, "Alice", "not final", { final: 0 });
  w.say(U1, "Alice", "   ");
  f.poll();
  assert.equal(got.length, 1);
  assert.deepEqual(
    { channelId: got[0].channelId, guildId: got[0].guildId, userId: got[0].userId, speaker: got[0].speaker, text: got[0].text },
    { channelId: C, guildId: G, userId: U1, speaker: "Alice", text: "Mina, hello" },
  );
  assert.match(got[0].key, /#1$/);
  f.poll();
  assert.equal(got.length, 1);
  assert.throws(() => f.db.exec("DELETE FROM meeting_transcript_utterances"));
  f.close();
});

test("waits for a database that does not exist yet, then follows it", async () => {
  await sqliteReady;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vwt-store-"));
  const file = path.join(dir, "openclaw.sqlite");
  const warns = [];
  const got = [];
  const f = new UtteranceFollower({ file, onUtterance: (u) => got.push(u), log: { info() {}, warn: (m) => warns.push(m) } });
  f.poll();
  f.poll();
  assert.equal(warns.length, 1); // reported once
  const w = makeDb(file);
  f.poll();
  w.say(U1, "Alice", "hi");
  f.poll();
  assert.equal(got.length, 1);
  f.close();
});

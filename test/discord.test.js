import test from "node:test";
import assert from "node:assert/strict";
import { speakerAuthorizer, memberLookup } from "../src/discord.js";

const members = { h1: { bot: false, roles: ["r-ok"] }, h2: { bot: false, roles: [] }, b1: { bot: true, roles: ["r-ok"] } };
const member = async (_g, id) => members[id] ?? null;

test("speakerAuthorizer: roles and users allow; bots, the agent and unknown members never", async () => {
  const a = speakerAuthorizer({ selfId: "me", member, allowRoleIds: ["r-ok"], allowUserIds: ["listed"] });
  const g = "g";
  assert.deepEqual(await a({ guildId: g, userId: "h1" }), { person: true, allowed: true });
  assert.deepEqual(await a({ guildId: g, userId: "h2" }), { person: true, allowed: false });
  assert.deepEqual(await a({ guildId: g, userId: "b1" }), { person: false, allowed: false });
  assert.deepEqual(await a({ guildId: g, userId: "me" }), { person: false, allowed: false });
  assert.deepEqual(await a({ guildId: g, userId: "unknown" }), { person: false, allowed: false });
  assert.deepEqual(await a({ guildId: g, userId: "listed" }), { person: true, allowed: true }); // listed id, lookup failed
  const all = speakerAuthorizer({ member, allowEveryone: true });
  assert.deepEqual(await all({ guildId: g, userId: "h2" }), { person: true, allowed: true });
  assert.deepEqual(await all({ guildId: g, userId: "b1" }), { person: false, allowed: false });
});

test("memberLookup: roles and bot flag, cached; failures are null and not cached", async () => {
  let calls = 0;
  let fail = true;
  const fetchImpl = async () => (calls++, fail ? { ok: false, status: 500 } : { ok: true, json: async () => ({ user: { bot: false }, roles: ["1", 2] }) });
  const m = memberLookup({ token: "T", fetchImpl });
  assert.equal(await m("g", "u"), null);
  fail = false;
  assert.deepEqual(await m("g", "u"), { bot: false, roles: ["1", "2"] });
  await m("g", "u");
  assert.equal(calls, 2);
});

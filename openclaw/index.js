// voice-wake-text for OpenClaw: when someone in a chosen Discord voice channel
// says the agent's name, the agent answers in text, in that voice channel's chat.
//
// Meant for listen-only capture (transcripts.autoStart with whenOccupied, no
// voice.autoJoin): the agent sits in the room silently, no realtime voice model
// runs, and the speech is transcribed by the configured batch speech-to-text.
// This plugin reads those saved utterances, and only when its name is called
// runs one agent turn.

import os from "node:os";
import path from "node:path";
import { UtteranceFollower, stateDbPath, sqliteReady } from "../src/store.js";
import { WakeEngine, DEFAULTS } from "../src/wake.js";
import { botCheck, botUserId } from "../src/discord.js";

export const PLUGIN_ID = "voice-wake-text";

export default {
  id: PLUGIN_ID,
  name: "Voice Wake Text",
  description:
    "When someone in a Discord voice channel says the agent's name, the agent answers in text in that voice channel's chat. For listen-only transcript capture: no realtime voice model. Off until configured.",
  register(api) {
    if (api.registrationMode && api.registrationMode !== "full") return;
    let running = null;
    api.registerService({
      id: PLUGIN_ID,
      reload: { configPrefixes: [`plugins.entries.${PLUGIN_ID}`] },
      async start(ctx) {
        running = await startService(api, ctx);
      },
      async stop() {
        const r = running;
        running = null;
        await r?.stop();
      },
    });
  },
};

export function resolveConfig(pc = {}) {
  const c = { ...DEFAULTS, agentId: "main", accountId: undefined, pollMs: 1000, timeoutMs: 180_000, ...pc };
  c.channelIds = (c.channelIds || []).map(String).filter(Boolean);
  c.names = (c.names || []).map(String).filter((n) => n.trim());
  return c;
}

export async function startService(api, ctx, { openDb, fetchImpl = fetch } = {}) {
  const log = prefixed(api.logger || console);
  const config = resolveConfig(api.pluginConfig);
  if (!config.channelIds.length || !config.names.length) {
    log.warn("off: set channelIds and names");
    return { async stop() {} };
  }
  const cfg = () => hostConfig(api, ctx);
  const token = discordToken(cfg(), config.accountId);
  let selfId = config.botUserId;
  if (!selfId && token) selfId = await botUserId(token, fetchImpl).catch((e) => (log.warn(`could not read the bot's own id: ${e.message}`), undefined));
  const isBot = token ? botCheck({ token, fetchImpl }) : null;

  const engine = new WakeEngine({
    config,
    log,
    isPerson: async (u) => {
      if (!u.userId) return false;
      if (selfId && u.userId === selfId) return false; // the agent itself
      if (!isBot || !u.guildId) return true;
      return (await isBot(u.guildId, u.userId)) !== true;
    },
    ask: (req) => askAgent(api, config, req, log),
    post: createPoster(api, ctx, config),
  });

  await sqliteReady;
  const file = config.stateDb || stateDbPath(stateDir(api));
  const follower = new UtteranceFollower({ file, log, openDb, onUtterance: (u) => engine.push(u) });
  log.info(`listening for ${config.names.join(" / ")} in ${config.channelIds.join(", ")}`);
  const tick = () => follower.poll();
  tick();
  const timer = setInterval(tick, config.pollMs);
  timer.unref?.();
  return {
    engine,
    follower,
    async stop() {
      clearInterval(timer);
      follower.close();
      await engine.stop();
    },
  };
}

/** One agent turn; returns the reply text, or null for no reply. */
export async function askAgent(api, config, { channelId, prompt, trigger }, log) {
  const sub = api.runtime?.subagent;
  if (!sub?.run) throw new Error("api.runtime.subagent is not available");
  const sessionKey = (config.sessionKey || "agent:{agentId}:voice-wake:{channelId}")
    .replaceAll("{agentId}", config.agentId)
    .replaceAll("{channelId}", channelId);
  const { runId, sessionKey: accepted } = await sub.run({
    sessionKey,
    message: prompt,
    deliver: false,
    idempotencyKey: `${PLUGIN_ID}:${trigger.key}`,
    ...(config.extraSystemPrompt ? { extraSystemPrompt: config.extraSystemPrompt } : {}),
  });
  const result = await sub.waitForRun({ runId, timeoutMs: config.timeoutMs });
  if (result.status !== "ok") {
    log.warn(`agent turn ${runId} ended: ${result.status}${result.error ? ` (${result.error})` : ""}`);
    return null;
  }
  const t = result.terminalReply;
  if (t?.disposition === "visible") return t.text;
  if (t?.disposition === "silent") return null;
  // Older or custom runtimes: read the last assistant message of the session.
  const { messages = [] } = (await sub.getSessionMessages?.({ sessionKey: accepted || sessionKey, limit: 5 })) || {};
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    return textOf(m.content);
  }
  return null;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
  return null;
}

/** Post through the Gateway's own Discord account, into the voice channel's chat. */
export function createPoster(api, ctx, config) {
  let adapter;
  return async function post(channelId, text) {
    adapter ??= await api.runtime.channel.outbound.loadAdapter("discord");
    if (!adapter?.sendText) throw new Error("Discord outbound adapter is not available");
    const result = await adapter.sendText({
      cfg: hostConfig(api, ctx),
      to: `channel:${channelId}`,
      text,
      ...(config.accountId ? { accountId: config.accountId } : {}),
    });
    return result?.messageId;
  };
}

/** The Discord bot token from the Gateway config, when it is a plain string. */
export function discordToken(cfg, accountId) {
  const d = cfg?.channels?.discord;
  const token = (accountId && d?.accounts?.[accountId]?.token) || d?.token;
  return typeof token === "string" && token ? token : undefined;
}

function hostConfig(api, ctx) {
  try {
    return api.runtime?.config?.current?.() || ctx?.config || api.config;
  } catch {
    return ctx?.config || api.config;
  }
}

function stateDir(api) {
  try {
    const dir = api.runtime?.state?.resolveStateDir?.();
    if (dir) return dir;
  } catch {}
  return process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
}

function prefixed(log) {
  return {
    info: (m) => log.info(`voice-wake-text: ${m}`),
    warn: (m) => log.warn(`voice-wake-text: ${m}`),
  };
}

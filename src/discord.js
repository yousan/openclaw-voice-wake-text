// Small Discord REST helpers: who the agent's bot is, and whether a speaker is a bot.

const API = "https://discord.com/api/v10";
const UA = "DiscordBot (https://github.com/yousan/openclaw-voice-wake-text, 0.1)";

export async function botUserId(token, fetchImpl = fetch) {
  const res = await fetchImpl(`${API}/users/@me`, { headers: { authorization: `Bot ${token}`, "user-agent": UA } });
  if (!res.ok) throw new Error(`users/@me: HTTP ${res.status}`);
  return (await res.json())?.id;
}

/** Is this guild member a bot? Cached. null when unknown (lookup failed). */
export function botCheck({ token, fetchImpl = fetch, ttlMs = 3_600_000 }) {
  const cache = new Map();
  return async function isBot(guildId, userId) {
    const key = `${guildId}/${userId}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.bot;
    let bot = null;
    try {
      const res = await fetchImpl(`${API}/guilds/${guildId}/members/${userId}`, {
        headers: { authorization: `Bot ${token}`, "user-agent": UA },
      });
      if (res.ok) bot = (await res.json())?.user?.bot === true;
    } catch {}
    if (bot !== null) cache.set(key, { bot, at: Date.now() });
    return bot;
  };
}

// Small Discord REST helpers: who the agent's bot is, and whether a speaker is a bot.

const API = "https://discord.com/api/v10";
const UA = "DiscordBot (https://github.com/yousan/openclaw-voice-wake-text, 0.1)";

export async function botUserId(token, fetchImpl = fetch) {
  const res = await fetchImpl(`${API}/users/@me`, { headers: { authorization: `Bot ${token}`, "user-agent": UA } });
  if (!res.ok) throw new Error(`users/@me: HTTP ${res.status}`);
  return (await res.json())?.id;
}

/** A guild member: { bot, roles }. Cached (10 min). null when unknown (lookup failed): callers fail closed. */
export function memberLookup({ token, fetchImpl = fetch, ttlMs = 600_000 }) {
  const cache = new Map();
  return async function member(guildId, userId) {
    const key = `${guildId}/${userId}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.member;
    let m = null;
    try {
      const res = await fetchImpl(`${API}/guilds/${guildId}/members/${userId}`, {
        headers: { authorization: `Bot ${token}`, "user-agent": UA },
      });
      if (res.ok) {
        const j = await res.json();
        m = { bot: j?.user?.bot === true, roles: Array.isArray(j?.roles) ? j.roles.map(String) : [] };
      }
    } catch {}
    if (m) cache.set(key, { member: m, at: Date.now() });
    return m;
  };
}

/**
 * Who may call. person: a human other than the agent; allowed: listed in
 * allowUserIds, or has one of allowRoleIds, or allowEveryone. Unknown members
 * (lookup failed or unavailable) are not people, except ids listed in allowUserIds.
 */
export function speakerAuthorizer({ selfId, member, allowUserIds = [], allowRoleIds = [], allowEveryone = false }) {
  const users = new Set(allowUserIds.map(String));
  const roles = new Set(allowRoleIds.map(String));
  return async function authorize(u) {
    const id = String(u.userId || "");
    if (!id || (selfId && id === selfId)) return { person: false, allowed: false };
    const m = member && u.guildId ? await member(u.guildId, id) : null;
    if (m?.bot) return { person: false, allowed: false };
    if (!m) return users.has(id) ? { person: true, allowed: true } : { person: false, allowed: false };
    const allowed = allowEveryone || users.has(id) || m.roles.some((r) => roles.has(r));
    return { person: true, allowed };
  };
}

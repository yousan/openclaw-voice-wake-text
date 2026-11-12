// Watch what is said in chosen voice channels; when someone says the agent's
// name, wait for them to finish, hand the conversation around it to the agent
// for one turn, and post the answer as text in the voice channel's chat.

export const DEFAULTS = {
  channelIds: [],
  names: [],
  ignoreWords: [],
  ignoreUserIds: [],
  contextLines: 12,
  contextMs: 180_000,
  settleMs: 3000,
  maxWaitMs: 12_000,
  cooldownMs: 10_000,
  replyTemplate: "{reply}",
  maxReplyChars: 1900,
  postTranscript: false,
  transcriptFlushMs: 5000,
  silentReply: "SKIP_REPLY",
  sessionHeader: false,
  sessionFooter: false,
  // Opt-in loose match for names the speech recognizer keeps getting wrong:
  // a regular expression tested only at the start of an utterance (after optional
  // fillers such as "ねえ"), on the normalized text. Mid-sentence matches never count.
  leadingCall: { enabled: false, patterns: [], fillers: [] },
};

export const LEADING_FILLERS = ["ねえ", "ねぇ", "ねー", "おーい", "おい", "あの", "あのさ", "えっと", "ちょっと"];

export const DEFAULT_PROMPT = [
  "You are listening silently in a Discord voice channel: you cannot speak there, and your reply will be posted as text in that voice channel's chat.",
  "Someone just called you by name. Below is the recent conversation, from speech recognition, so expect recognition errors (your name may be misheard too). The line marked ▶ is where you were called.",
  "",
  "{lines}",
  "",
  "Answer what you were asked, briefly, in the language they are speaking. Write only the reply itself: it is posted for you, so do not send it with a messaging tool.",
  "If nobody was actually talking to you (your name only came up in passing), reply with exactly {silent}.",
].join("\n");

/** Lowercase, width-fold, and drop spaces and punctuation, so "ミナ、" and "ﾐﾅ" both match "ミナ". */
export function normalize(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

/** Does `text` call one of `names`? `ignoreWords` (e.g. "みなさん") are removed first. */
export function callsName(text, names, ignoreWords = []) {
  let t = normalize(text);
  for (const w of ignoreWords.map(normalize).filter(Boolean).sort((a, b) => b.length - a.length)) t = t.split(w).join(" ");
  return names.map(normalize).some((n) => n && t.includes(n));
}

/** Does the utterance start with a call that matches one of `patterns` (after fillers)? */
export function leadingCall(text, { patterns = [], fillers = LEADING_FILLERS } = {}) {
  const res = patterns.map((p) => (p instanceof RegExp ? p : new RegExp(p, "u")));
  if (!res.length) return false;
  let t = normalize(text);
  const fs = fillers.map(normalize).filter(Boolean).sort((a, b) => b.length - a.length);
  for (let stripped = true; stripped; ) {
    stripped = false;
    for (const f of fs) if (t.startsWith(f)) (t = t.slice(f.length)), (stripped = true);
  }
  return res.some((re) => (re.source.startsWith("^") ? re : new RegExp("^(?:" + re.source + ")", re.flags)).test(t));
}

export class WakeEngine {
  /**
   * @param {object} o
   * @param {object} o.config
   * @param {(u: object) => Promise<boolean>|boolean} [o.isPerson]  may this speaker call the agent? (not a bot, not the agent)
   * @param {(req: {channelId: string, guildId: string, prompt: string, trigger: object, lines: object[]}) => Promise<string|null>} o.ask
   * @param {(channelId: string, text: string) => Promise<any>} o.post
   */
  constructor({ config, isPerson = () => true, ask, post, log, now = Date.now }) {
    this.c = { ...DEFAULTS, ...config };
    this.channelIds = new Set((this.c.channelIds || []).map(String));
    this.ignoreUserIds = new Set((this.c.ignoreUserIds || []).map(String));
    this.isPerson = isPerson;
    this.ask = ask;
    this.post = post;
    this.log = log || { info() {}, warn() {} };
    this.now = now;
    this.rooms = new Map();
    this.seen = new Set();
    this.chain = Promise.resolve();
    this.stopped = false;
    this.pending = new Set();
  }

  get enabled() {
    return this.channelIds.size > 0 && (this.c.names || []).some((n) => normalize(n));
  }

  /** Feed one saved utterance (see store.js). Handled in order. */
  push(u) {
    if (this.stopped || !u || !this.channelIds.has(String(u.channelId))) return this.chain;
    if (this.seen.has(u.key)) return this.chain; // never twice for the same utterance
    this.seen.add(u.key);
    if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500));
    this.chain = this.chain.then(() => this.handle(u)).catch((e) => this.log.warn(`handling an utterance failed: ${e.message}`));
    return this.chain;
  }

  isCall(text) {
    if (callsName(text, this.c.names, this.c.ignoreWords)) return true;
    const lc = this.c.leadingCall;
    return !!(lc?.enabled && leadingCall(text, { patterns: lc.patterns || [], fillers: lc.fillers?.length ? lc.fillers : LEADING_FILLERS }));
  }

  /** A capture in a chosen room started or stopped: post the notice (after any pending transcript). */
  session(ev) {
    if (this.stopped || !ev || !this.channelIds.has(String(ev.channelId))) return this.chain;
    const template = ev.started ? this.c.sessionHeader : this.c.sessionFooter;
    this.chain = this.chain
      .then(async () => {
        const r = this.room(ev);
        await this.flushTranscript(r);
        if (!template) return;
        await this.post(r.channelId, fillNotice(template, ev, this.c));
        this.log.info(`${ev.started ? "joined" : "left"} ${r.channelId}; notice posted`);
      })
      .catch((e) => this.log.warn(`posting the ${ev.started ? "join" : "leave"} notice failed: ${e.message}`));
    return this.chain;
  }

  room(u) {
    let r = this.rooms.get(u.channelId);
    if (!r) {
      r = { channelId: u.channelId, guildId: u.guildId, history: [], collecting: null, running: false, queued: null, lastRunAt: -Infinity, transcript: [], flushTimer: null, covered: new Set() };
      this.rooms.set(u.channelId, r);
    }
    if (u.guildId) r.guildId = u.guildId;
    return r;
  }

  async handle(u) {
    const r = this.room(u);
    r.history.push(u);
    const oldest = this.now() - Math.max(this.c.contextMs, this.c.maxWaitMs * 2);
    while (r.history.length > 200 || (r.history.length > this.c.contextLines * 2 && r.history[0].at < oldest)) r.history.shift();
    if (this.c.postTranscript) this.queueTranscript(r, u);

    if (r.collecting) this.extend(r);
    if (!this.isCall(u.text)) return;
    if (this.ignoreUserIds.has(String(u.userId)) || !(await this.isPerson(u))) {
      this.log.info(`name heard from ${u.userId || "?"} (not a person, ignored)`);
      return;
    }
    if (r.collecting) return; // part of the call being collected
    if (r.running || this.now() - r.lastRunAt < this.c.cooldownMs) {
      // Called again while busy: answer once more afterwards, for the latest call only.
      r.queued = u;
      this.log.info(`name heard again in ${u.channelId}; will answer after the current reply`);
      if (!r.running) this.scheduleQueued(r);
      return;
    }
    this.collect(r, u);
  }

  collect(r, trigger) {
    this.log.info(`called in ${r.channelId} by ${trigger.speaker}`);
    r.collecting = { trigger, startedAt: this.now(), timer: null };
    this.extend(r);
  }

  // Wait until the room has been quiet for settleMs, at most maxWaitMs after the call.
  extend(r) {
    const c = r.collecting;
    if (!c) return;
    clearTimeout(c.timer);
    const left = Math.max(0, c.startedAt + this.c.maxWaitMs - this.now());
    c.timer = setTimeout(() => this.fire(r), Math.min(this.c.settleMs, left));
    c.timer.unref?.();
  }

  fire(r) {
    const c = r.collecting;
    if (!c || this.stopped) return;
    r.collecting = null;
    r.running = true;
    r.lastRunAt = this.now();
    this.chain = this.chain.then(() => this.answer(r, c.trigger)).catch((e) => this.log.warn(`answer failed: ${e.message}`));
  }

  async answer(r, trigger) {
    const lines = this.contextFor(r, trigger);
    for (const l of lines) r.covered.add(l.key);
    if (r.covered.size > 2000) r.covered = new Set([...r.covered].slice(-1000));
    const prompt = buildPrompt(this.c.prompt || DEFAULT_PROMPT, lines, trigger, this.c);
    // Answer off the ordered chain, so later utterances keep flowing in.
    const work = (async () => {
      let reply = null;
      try {
        reply = await this.ask({ channelId: r.channelId, guildId: r.guildId, prompt, trigger, lines });
      } catch (e) {
        this.log.warn(`agent turn failed: ${e.message}`);
      }
      reply = cleanReply(reply, this.c);
      if (reply) {
        await this.flushTranscript(r);
        const text = this.c.replyTemplate
          .replaceAll("{speaker}", trigger.speaker)
          .replaceAll("{text}", trigger.text)
          .replaceAll("{reply}", reply);
        try {
          await this.post(r.channelId, clip(text, this.c.maxReplyChars + 100));
          this.log.info(`answered in ${r.channelId}`);
        } catch (e) {
          this.log.warn(`posting the reply failed: ${e.message}`);
        }
      } else {
        this.log.info(`no reply for the call in ${r.channelId}`);
      }
      r.running = false;
      this.scheduleQueued(r);
    })();
    this.pending.add(work);
    work.finally(() => this.pending.delete(work));
  }

  scheduleQueued(r) {
    const q = r.queued;
    if (!q || r.running || r.collecting || this.stopped) return;
    if (r.covered.has(q.key)) {
      r.queued = null; // already part of the conversation just answered
      return;
    }
    const wait = r.lastRunAt + this.c.cooldownMs - this.now();
    if (wait > 0) {
      clearTimeout(r.queuedTimer);
      r.queuedTimer = setTimeout(() => this.scheduleQueued(r), wait);
      r.queuedTimer.unref?.();
      return;
    }
    r.queued = null;
    this.collect(r, q);
  }

  contextFor(r, trigger) {
    const i = r.history.findIndex((h) => h.key === trigger.key);
    const idx = i < 0 ? r.history.length : i;
    const before = r.history.slice(0, idx).filter((h) => trigger.at - h.at <= this.c.contextMs).slice(-this.c.contextLines);
    const after = r.history.slice(idx + 1);
    return [...before, trigger, ...after];
  }

  queueTranscript(r, u) {
    r.transcript.push(`**${escapeMarkdown(u.speaker)}**: ${defuse(u.text)}`);
    if (!r.flushTimer) {
      r.flushTimer = setTimeout(() => this.flushTranscript(r), this.c.transcriptFlushMs);
      r.flushTimer.unref?.();
    }
  }

  async flushTranscript(r) {
    clearTimeout(r.flushTimer);
    r.flushTimer = null;
    if (!r.transcript.length) return;
    const lines = r.transcript.splice(0);
    for (const msg of chunk(lines)) {
      try {
        await this.post(r.channelId, msg);
      } catch (e) {
        this.log.warn(`posting the transcript failed: ${e.message}`);
      }
    }
  }

  async stop() {
    this.stopped = true;
    for (const r of this.rooms.values()) {
      clearTimeout(r.collecting?.timer);
      clearTimeout(r.queuedTimer);
    }
    await this.chain;
    await Promise.all([...this.pending]);
    for (const r of this.rooms.values()) await this.flushTranscript(r);
  }
}

function fillNotice(template, ev, c) {
  return String(template)
    .replaceAll("{channelId}", ev.channelId)
    .replaceAll("{guildId}", ev.guildId || "")
    .replaceAll("{name}", (c.names || [])[0] || "");
}

export function buildPrompt(template, lines, trigger, c = DEFAULTS) {
  const body = lines
    .map((l) => `${l.key === trigger.key ? "▶ " : "  "}[${clock(l.at, c.timeZone)}] ${l.speaker}: ${l.text}`)
    .join("\n");
  return template.replaceAll("{lines}", body).replaceAll("{silent}", c.silentReply || "SKIP_REPLY");
}

function cleanReply(reply, c) {
  if (typeof reply !== "string") return null;
  const t = reply.trim();
  if (!t) return null;
  const bare = t.replace(/[.。\s]/g, "");
  if ((c.silentReply && bare === c.silentReply) || bare === "NO_REPLY") return null;
  return defuse(clip(t, c.maxReplyChars));
}

function clip(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Nothing in a reply or a transcript may ping @everyone / @here.
function defuse(s) {
  return String(s).replace(/@(everyone|here)/g, "@​$1");
}

function escapeMarkdown(s) {
  return String(s).replace(/([\\*_`~|>])/g, "\\$1");
}

export function chunk(lines, limit = 2000) {
  const out = [];
  let cur = "";
  for (let line of lines) {
    while (line.length > limit) {
      if (cur) out.push(cur), (cur = "");
      out.push(line.slice(0, limit));
      line = line.slice(limit);
    }
    if (cur && cur.length + 1 + line.length > limit) out.push(cur), (cur = "");
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}

function clock(at, timeZone) {
  return new Date(at).toLocaleTimeString("en-GB", { hour12: false, ...(timeZone ? { timeZone } : {}) });
}

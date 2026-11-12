// Follow the utterances OpenClaw's transcript capture saves.
//
// In listen-only capture (transcripts.autoStart without a conversational
// voice.autoJoin target) the Discord voice runtime starts no realtime model and
// logs no transcript lines. Each utterance it transcribes (batch speech-to-text)
// is saved as a row of `meeting_transcript_utterances` in the Gateway's shared
// SQLite state database. This reads new rows, read-only, by rowid.
//
// Not a public API: the table shape is pinned by tests against OpenClaw 2026.10.2.

import fs from "node:fs";
import path from "node:path";

export function stateDbPath(stateDir) {
  return path.join(stateDir, "state", "openclaw.sqlite");
}

const QUERY = `
SELECT u.rowid AS rowid, u.session_id AS sessionId, u.sequence AS sequence,
       u.speaker_id AS speakerId, u.speaker_label AS speakerLabel, u.text AS text,
       u.started_at AS startedAt, u.ended_at AS endedAt, u.final AS final,
       u.metadata_json AS metadataJson, s.source_json AS sourceJson, s.provider_id AS providerId
  FROM meeting_transcript_utterances u
  LEFT JOIN meeting_transcript_sessions s
    ON s.session_id = u.session_id AND s.started_at = u.session_started_at
 WHERE u.rowid > ?
 ORDER BY u.rowid
 LIMIT ?`;

const SESSIONS = `
SELECT session_id AS sessionId, started_at AS startedAt, stopped_at AS stoppedAt,
       source_json AS sourceJson, provider_id AS providerId, updated_at_ms AS updatedAtMs
  FROM meeting_transcript_sessions
 WHERE updated_at_ms >= ?
 ORDER BY updated_at_ms`;

/** Turn one database row into an utterance, or null when it is not a usable Discord voice line. */
export function toUtterance(row) {
  if (!row || row.final === 0) return null;
  const meta = parseJson(row.metadataJson);
  const source = parseJson(row.sourceJson);
  const channelId = str(meta.channelId) || str(source.channelId);
  const guildId = str(meta.guildId) || str(source.guildId);
  const provider = str(row.providerId) || str(source.providerId);
  if (provider && provider !== "discord-voice") return null;
  const text = String(row.text ?? "").trim();
  if (!channelId || !text) return null;
  const at = Date.parse(row.endedAt || row.startedAt || "");
  return {
    key: `${row.sessionId}#${row.sequence}`,
    rowid: Number(row.rowid),
    guildId,
    channelId,
    sessionId: row.sessionId,
    userId: str(row.speakerId),
    speaker: str(row.speakerLabel) || str(row.speakerId) || "?",
    text,
    at: Number.isFinite(at) ? at : Date.now(),
  };
}

export class UtteranceFollower {
  /**
   * @param {object} o
   * @param {string} o.file              the state database
   * @param {(u: object) => void} o.onUtterance
   * @param {{info: Function, warn: Function}} [o.log]
   * @param {() => any} [o.openDb]        for tests: returns an object with prepare(sql).all(...args)
   * @param {boolean} [o.fromStart]      read existing rows too (default: only rows added after start)
   */
  constructor({ file, onUtterance, onSession, log, openDb, fromStart = false, batch = 200 }) {
    this.file = file;
    this.onUtterance = onUtterance;
    this.onSession = onSession; // ({started, guildId, channelId, sessionId}) when a capture starts or stops
    this.sessions = new Map(); // "<id>|<started_at>" -> active
    this.sessionCursor = null;
    this.log = log || { info() {}, warn() {} };
    this.openDb = openDb || (() => openReadOnly(file));
    this.cursor = fromStart ? 0 : null; // null: start at the current end on first open
    this.batch = batch;
    this.db = null;
    this.stmt = null;
    this.lastError = null;
  }

  poll() {
    try {
      if (!this.db) this.open();
      if (!this.db) return 0;
      if (this.onSession) this.pollSessions();
      let n = 0;
      for (;;) {
        const rows = this.stmt.all(this.cursor, this.batch);
        for (const row of rows) {
          this.cursor = Math.max(this.cursor, Number(row.rowid));
          const u = toUtterance(row);
          if (u) this.onUtterance(u), n++;
        }
        if (rows.length < this.batch) break;
      }
      this.lastError = null;
      return n;
    } catch (e) {
      this.report(e);
      this.close();
      return 0;
    }
  }

  // A capture session is active while stopped_at is empty. Report changes, not
  // the state found at start (a restart is not a new stay).
  pollSessions() {
    const first = this.sessionCursor == null;
    const rows = this.sessionStmt.all(first ? 0 : this.sessionCursor);
    for (const row of rows) {
      this.sessionCursor = Math.max(this.sessionCursor ?? 0, Number(row.updatedAtMs) || 0);
      const source = parseJson(row.sourceJson);
      if ((str(row.providerId) || str(source.providerId)) !== "discord-voice") continue;
      const key = `${row.sessionId}|${row.startedAt}`;
      const active = !row.stoppedAt;
      const before = this.sessions.get(key);
      this.sessions.set(key, active);
      if (first || before === active || (before === undefined && !active)) continue;
      this.onSession({ started: active, sessionId: row.sessionId, guildId: str(source.guildId), channelId: str(source.channelId) });
    }
    if (first) this.sessionCursor ??= 0;
    if (this.sessions.size > 500) this.sessions = new Map([...this.sessions].slice(-250));
  }

  open() {
    const db = this.openDb();
    if (!db) return;
    this.db = db;
    this.stmt = db.prepare(QUERY);
    if (this.onSession) this.sessionStmt = db.prepare(SESSIONS);
    if (this.cursor == null) {
      const row = db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM meeting_transcript_utterances").get();
      this.cursor = Number(row?.m ?? 0);
      this.log.info(`reading utterances after row ${this.cursor} of ${this.file}`);
    }
  }

  report(e) {
    const msg = e?.message || String(e);
    if (msg !== this.lastError) this.log.warn(`reading ${this.file} failed: ${msg}`);
    this.lastError = msg;
  }

  close() {
    try {
      this.db?.close?.();
    } catch {}
    this.db = null;
    this.stmt = null;
    this.sessionStmt = null;
  }
}

let DatabaseSync;
async function loadSqlite() {
  ({ DatabaseSync } = await import("node:sqlite"));
}
export const sqliteReady = loadSqlite().catch(() => {});

function openReadOnly(file) {
  if (!DatabaseSync) throw new Error("node:sqlite is not available (Node 22.13+ needed)");
  if (!fs.existsSync(file)) throw new Error("no such file");
  return new DatabaseSync(file, { readOnly: true });
}

function parseJson(s) {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function str(v) {
  return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : "";
}

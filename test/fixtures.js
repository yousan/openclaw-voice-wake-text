// The two tables as OpenClaw 2026.10.2 creates them (state/openclaw.sqlite). Dummy ids.
import { DatabaseSync } from "node:sqlite";

export const G = "100000000000000001";
export const C = "200000000000000002";
export const OTHER = "200000000000000009";
export const U1 = "300000000000000003";
export const U2 = "300000000000000004";
export const BOT = "300000000000000099";

export const SCHEMA = `
CREATE TABLE meeting_transcript_sessions (
  session_id TEXT NOT NULL, started_at TEXT NOT NULL, selector TEXT NOT NULL, export_key TEXT NOT NULL,
  session_slug TEXT NOT NULL, provider_id TEXT NOT NULL, title TEXT, source_json TEXT NOT NULL,
  stopped_at TEXT, metadata_json TEXT, export_manifest_json TEXT NOT NULL DEFAULT '{}',
  export_pending_json TEXT NOT NULL DEFAULT '[]', next_utterance_seq INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, started_at)
);
CREATE TABLE meeting_transcript_utterances (
  session_id TEXT NOT NULL,
  session_started_at TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  utterance_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  speaker_id TEXT,
  speaker_label TEXT,
  text TEXT NOT NULL,
  final INTEGER CHECK (final IN (0, 1)),
  metadata_json TEXT,
  PRIMARY KEY (session_id, session_started_at, sequence),
  FOREIGN KEY (session_id, session_started_at)
    REFERENCES meeting_transcript_sessions(session_id, started_at)
    ON DELETE CASCADE
) STRICT;`;

export function makeDb(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL;" + SCHEMA);
  const S = "transcript-2026-01-02T03-04-05-000Z-abcd1234";
  const START = "2026-01-02T03:04:05.000Z";
  db.prepare(
    `INSERT INTO meeting_transcript_sessions (session_id, started_at, selector, export_key, session_slug, provider_id, source_json, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, 'discord-voice', ?, 0, 0)`,
  ).run(S, START, `2026-01-02/${S}`, `2026-01-02/${S}`, S, JSON.stringify({ providerId: "discord-voice", accountId: "default", guildId: G, channelId: C, agentId: "main" }));
  let seq = 0;
  return {
    db,
    say(userId, label, text, { channelId = C, final = 1, at = Date.now() } = {}) {
      db.prepare(
        `INSERT INTO meeting_transcript_utterances (session_id, session_started_at, sequence, ended_at, speaker_id, speaker_label, text, final, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(S, START, seq++, new Date(at).toISOString(), userId, label, text, final,
        JSON.stringify({ channel: "discord", guildId: G, channelId, voiceSessionKey: `agent:main:discord:channel:${channelId}` }));
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

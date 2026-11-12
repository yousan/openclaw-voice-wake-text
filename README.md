# OpenClaw Voice Wake Text

**Your OpenClaw agent sits silently in a Discord voice channel. When someone says its name, it answers in text, in that voice channel's own chat.**

MIT · OpenClaw plugin · verified with **OpenClaw 2026.10.2 + `@openclaw/discord` 2026.10.2** · no realtime voice model

```text
#lounge (the voice channel's own chat)
**Alice**: Shall we go to the beach this weekend?
**Bob**: Mina, what's the weather on Saturday?
Saturday in Tokyo looks sunny, 18 °C, with a light wind from the north.
```

> [!WARNING]
> **This sends what people say in the room to your agent's model when its name is called**, and can post everything said in the room as text (`postTranscript`). It is **off until you choose rooms** (`channelIds`) **and names** (`names`). Tell participants before they speak.

## Why

OpenClaw's Discord voice can talk back with a realtime voice model (e.g. GPT-Live). That costs realtime quota for every minute in the room, and the agent speaks over the conversation. Sometimes you want the opposite: the agent listens, stays quiet, and answers in text only when asked.

OpenClaw already has the listening part. With a [`transcripts.autoStart`](https://docs.openclaw.ai/channels/discord/voice-transcripts) source and **no** conversational `voice.autoJoin` for that room, the agent joins when people arrive and records **listen-only**: *"capture is listen-only and does not start a realtime provider"*. Each utterance is transcribed by your configured speech-to-text (a local one such as sherpa-onnx works) and saved. What is missing is answering: *"Summaries are not automatically posted to Discord."* This plugin adds that.

## How it works

```text
voice channel ──audio──▶ OpenClaw transcript capture (listen-only, batch STT)
                              │ saves each utterance
                              ▼
               <state dir>/state/openclaw.sqlite  (meeting_transcript_utterances)
                              │ read-only, ~1 s
                              ▼
               voice-wake-text service inside the Gateway
                 · utterance contains a name? → wait until the room is quiet (settleMs)
                 · send the conversation around the call to the agent: one turn
                              ▼
               reply posted by the agent's Discord account in the voice channel's chat
```

- **Calls.** An utterance calls the agent when it contains one of `names`, ignoring case, full/half width, spaces and punctuation. Speech recognition mishears names, so list the variants you see (`"Mina"`, `"Nina"`, `"ミナ"`, `"みな"`). `ignoreWords` are removed before matching, for ordinary words that contain the name.
- **The rest of the request.** People often say the name, pause, then ask. After a call it waits until nobody has said anything for `settleMs` (at most `maxWaitMs`), and includes what was said in between.
- **Context.** The agent gets the `contextLines` utterances before the call (within `contextMs`), the call (marked `▶`) and what followed, with names and times, and is told it is listening silently and its reply is posted as text. It may answer `SKIP_REPLY` when the name only came up in passing; nothing is posted then.
- **One answer per call.** Each saved utterance is handled once. Calls made while the agent is answering, or within `cooldownMs` after, are collapsed into one more answer for the latest call (skipped if the previous answer already saw it).
- **Who can call.** Not the agent itself, not other bots (Discord member lookup), not `ignoreUserIds`. Who may talk to the agent in text is unchanged: `@agent` in the chat works as before.
- **Session.** By default each voice channel has its own agent session, `agent:<agentId>:voice-wake:<channelId>`, so it remembers earlier calls in that room. The run uses the agent's normal model, tools and memory.
- **Transcript (optional).** `postTranscript: true` also posts every utterance (`**Name**: text`), collected for `transcriptFlushMs`. In listen-only rooms the Gateway logs no realtime transcript lines, so log-based relays have nothing to post there; this covers that.

## Install

From a clone (this plugin is not published to ClawHub or npm):

```sh
git clone https://github.com/yousan/openclaw-voice-wake-text
openclaw plugins install --link ./openclaw-voice-wake-text
```

Then make the room listen-only and choose the names:

```json5
{
  channels: { discord: { voice: { enabled: true /* no autoJoin entry for this room */ } } },
  tools: { media: { audio: { enabled: true }, models: [/* a speech-to-text model, e.g. sherpa-onnx as a cli model */] } },
  transcripts: {
    autoStart: [
      { providerId: "discord-voice", guildId: "123456789012345678", channelId: "234567890123456789", whenOccupied: true },
    ],
  },
  plugins: {
    entries: {
      "voice-wake-text": {
        enabled: true,
        config: {
          channelIds: ["234567890123456789"],
          names: ["Mina", "Nina"],
        },
      },
    },
  },
}
```

```sh
openclaw config validate
openclaw gateway restart
```

The Gateway log shows `voice-wake-text: listening for …`, and on a call `called in <channel> by <name>` and `answered in <channel>`. When the agent joins the room, the log should show `discord voice: joined … ` and **no** `realtime bridge starting` line.

Only one occupancy-driven capture per server is possible (an OpenClaw limit), so one listen-only room per server.

## Configuration

`plugins.entries.voice-wake-text.config`:

| key | default | |
|---|---|---|
| `channelIds` | none | Voice channels to answer in. **Off until set** |
| `names` | none | What people call the agent, with likely mishearings. **Off until set** |
| `ignoreWords` | `[]` | Removed before matching (e.g. `"みなさん"` when a name is `"みな"`) |
| `ignoreUserIds` | `[]` | Speakers whose calls are ignored (bots and the agent are always ignored) |
| `agentId` | `main` | The agent that answers |
| `sessionKey` | `agent:{agentId}:voice-wake:{channelId}` | Agent session for the turn |
| `contextLines` | `12` | Utterances before the call that are sent along |
| `contextMs` | `180000` | …only if they are at most this old |
| `settleMs` | `3000` | Wait until the room has been quiet this long after a call |
| `maxWaitMs` | `12000` | Never wait longer than this after a call |
| `cooldownMs` | `10000` | Minimum time between two answers in one room |
| `timeoutMs` | `180000` | Give up waiting for the agent after this |
| `prompt` | see `src/wake.js` | Message sent to the agent; `{lines}` = conversation, `{silent}` = `silentReply` |
| `extraSystemPrompt` | none | Extra system prompt for the turn |
| `silentReply` | `SKIP_REPLY` | Reply meaning "say nothing". Not OpenClaw's own `NO_REPLY`: some agent backends (the Claude CLI backend in 2026.10.2) treat a bare `NO_REPLY` as an empty response and retry with a fallback model |
| `replyTemplate` | `{reply}` | Posted text; `{speaker}` and `{text}` = who called and what they said |
| `maxReplyChars` | `1900` | Longer replies are cut |
| `postTranscript` | `false` | Also post every utterance in the chat |
| `transcriptFlushMs` | `5000` | Collect transcript lines this long per message |
| `timeZone` | host | Time zone of the times in the prompt |
| `accountId` | default | Which configured Discord account posts and looks up members |
| `pollMs` | `1000` | How often new utterances are read |
| `stateDb` | `<state dir>/state/openclaw.sqlite` | The Gateway's state database |

## Limitations

- **It reads the Gateway's state database, not an API.** OpenClaw 2026.10.2 exposes no plugin hook for saved transcript utterances, so this reads `meeting_transcript_utterances` read-only. The table shape is pinned by tests against 2026.10.2; a Gateway update can change it.
- **Use `whenOccupied: true`.** In OpenClaw 2026.10.2 (also seen in the 2026.10.6 Discord plugin code), a capture started outside Discord's own event handling — a continuous `transcripts.autoStart` entry without `whenOccupied` — fails to join with `Discord runtime not initialized` (the Gateway only logs `start-failed`). Occupancy-driven starts come from Discord's voice events and are not affected. For the same reason, a room that is already occupied when the Gateway starts may not be joined until someone joins or leaves.
- **Delay.** Batch transcription happens after someone stops talking, then `settleMs`, then the agent's turn: expect several seconds to a few tens of seconds.
- **Recognition errors.** A misheard name is a missed call; add the variant to `names`. A word that sounds like the name is a false call; the agent can answer `SKIP_REPLY`, or add the word to `ignoreWords`.
- **Meeting notes still run.** Transcript capture also writes meeting notes with the agent's utility model about every five minutes while people talk (OpenClaw behaviour, not this plugin).
- **Restarts.** After a Gateway restart it starts from new utterances; calls made while it was down are not answered.

## Development

```sh
npm test   # node --test; uses node:sqlite (Node 22.13+)
```

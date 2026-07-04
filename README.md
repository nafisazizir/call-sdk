# Call SDK

[![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

A unified toolkit for building real-time AI voice agents across any telephony or voice provider. Call SDK is the voice-native sibling of Vercel's [Chat SDK](https://chat-sdk.dev) — where Chat SDK abstracts text chat providers behind a common interface, Call SDK abstracts _voice_ providers (Twilio, WebRTC, WhatsApp calls, and others) behind a consistent set of composable primitives. Write your agent logic once and run it on any provider by swapping an adapter.

```ts
const call = new Call({
  adapters: {
    twilio: createTwilioAdapter({ mediaPath: "/twilio/media" }),
  },
  stages: [createDeepgramStage(), createElevenLabsStage()],
  onCallStarted: (session) => {
    void session.say("Hi! How can I help you today?");
  },
  onEndOfTurn: async (_turn, session) => {
    const { textStream } = streamText({
      model: anthropic("claude-opus-4-8"),
      system: SYSTEM_PROMPT,
      messages: toModelMessages(session.transcript),
    });
    await session.say(textStream);
  },
});

// call.webhooks.twilio  -> mount on any HTTP route (control plane)
// call.media.twilio     -> mount on any WebSocket route (media plane)
```

That's the whole wiring for a working phone agent: real caller audio in, VAD and turn detection done for you, an LLM-driven reply spoken back out, barge-in handled automatically. See [`examples/twilio-on-ws`](examples/twilio-on-ws) for the full, runnable version.

## How it works

Three layers, bottom to top:

1. **Adapters (thin).** An adapter does exactly two things: emit call lifecycle events (started, answered, ended) and move normalized audio bidirectionally. It has no opinion about speech, turns, or transcription — even when the underlying provider offers all of that for free. v1 ships one: `@call-adapter/twilio`, built on Twilio's raw Media Streams, not its managed voice-AI product.
2. **The audio processing pipeline (SDK-owned).** VAD → streaming STT → turn detection → TTS, wired above every adapter identically. The spine is a typed, synchronous event bus, not a chain of stream transforms — VAD emits signals, STT emits many events per utterance, turn detection emits a decision, none of which is a 1:1 byte transform. Stages are swappable units, each declaring the events it `consumes` and `emits`, instantiated fresh per call.
3. **Your agent logic.** Handlers hung off `onCallStarted`, `onEndOfTurn`, etc. (or raw bus subscriptions — see below), plus `session.say()` to talk back.

## Core promises

- **Turn detection ≠ silence detection.** "The audio went quiet" is not "the caller is done speaking." `end-of-turn` is a distinct, swappable stage from VAD's raw `speech-start`/`speech-end` — never conflated, never a hardcoded silence timer masquerading as understanding.
- **Duplex, with real barge-in.** The pipeline tracks who's speaking. A `speech-start` while the agent is talking is an interruption: TTS generation is aborted and the adapter's outbound queue is flushed (`clear()`) — because stopping generation alone leaves already-buffered audio playing.
- **Exactly-once `call-ended`.** Every call — normal hangup, dropped media socket, upstream failure, unhandled error — ends through one teardown path and fires `call-ended` exactly once. Stages are disposed in reverse attach order; adapter operations after end are logged no-ops, not throws.
- **Canonical audio, everywhere.** Every adapter normalizes to PCM16 mono @ 16kHz on the way in and de-normalizes on the way out, so one VAD/STT/turn configuration works identically across every provider.
- **Host-agnostic by construction.** Adapters expose a fetch-style `Request → Response` webhook handler and a structural `MediaSocket` handler — no framework, no assumed runtime. Mount them anywhere.

## Packages

| Package | npm name | Role |
| --- | --- | --- |
| [`packages/call-sdk`](packages/call-sdk) | `call-sdk` | Core SDK — `Call`, `CallSession`, the typed event bus, default pipeline wiring, audio primitives |
| [`packages/adapter-twilio`](packages/adapter-twilio) | `@call-adapter/twilio` | Twilio telephony adapter (raw Media Streams) |
| [`packages/stt-deepgram`](packages/stt-deepgram) | `@call-adapter/stt-deepgram` | Deepgram streaming transcription stage |
| [`packages/tts-elevenlabs`](packages/tts-elevenlabs) | `@call-adapter/tts-elevenlabs` | ElevenLabs speech synthesis stage |
| [`packages/tests`](packages/tests) | `@call-adapter/tests` | Shared Vitest conformance suite + mocks for adapter/stage authors |
| [`examples/twilio-on-ws`](examples/twilio-on-ws) | `example-twilio-on-ws` | Minimal runnable agent: Twilio + Deepgram + ElevenLabs + the AI SDK over a raw WebSocket |

## Event taxonomy

The full public event surface (`CallEventMap` in `call-sdk`'s `events.ts`):

| Event | Meaning |
| --- | --- |
| `call-started` | The session's pipeline stages have attached; the call is live. |
| `call-answered` | The provider reports the call was answered / media is flowing. |
| `call-ended` | Terminal fact. Fires exactly once, on every teardown path. |
| `audio-frame` | One inbound canonical PCM16/16kHz audio frame from the adapter. |
| `speech-start` / `speech-end` | Raw VAD signal — voice energy detected/stopped. Not the same as a turn. |
| `transcript-interim` | An in-progress (non-final) transcript segment from a streaming STT stage. |
| `transcript-final` | A finalized transcript segment for one STT-detected utterance. |
| `stt-endpoint` | An STT provider's own endpointing signal, optionally consumed by turn detection. |
| `end-of-turn` | The caller has actually finished their turn — the "respond now" signal. |
| `agent-say` | The sole command event: synthesize and speak this text. |
| `audio-out` | One canonical PCM16/16kHz audio frame of TTS output, for the adapter to play. |
| `agent-generation-end` | Fact from the TTS stage: no further `audio-out` will follow for this utterance. |
| `agent-speech-start` / `agent-speech-end` | The agent's utterance began / finished playing back (`interrupted` flag on end). |
| `interruption` | A barge-in was detected. Core executes the consequences; this just reports it. |
| `error` | A session-level error from a stage, adapter, or handler (`fatal` gates auto-teardown). |
| `telemetry` | A latency instrumentation mark was recorded. |

## Low-level entry point

Everything above is sugar over one thing: `session.bus`, a typed, synchronous pub/sub bus. Subscribe directly for full control — your own transcriber, your own turn model, anything:

```ts
session.on("transcript-final", (event) => { /* ... */ });
session.bus.publish("agent-say", { utteranceId, text, signal });
```

A **stage** is the unit that plugs into the bus — a named, factory-configured, per-session processor:

```ts
interface Stage {
  readonly name: string;
  readonly consumes: readonly CallEventType[]; // validated at `new Call(...)` setup time
  readonly emits: readonly CallEventType[];
  attach(ctx: StageContext): StageHandle | Promise<StageHandle>; // per-call instantiation
}
```

`call-sdk` ships two default stages so the pipeline works out of the box (`createEnergyVadStage`, `createSilenceTurnStage`), auto-injected unless your own stages already cover the role.

## Telemetry

Every stage boundary is instrumented from the first commit — audio-in, first transcript, end-of-turn, TTS first byte, first outbound write, call-ended — so bottlenecks are locatable from data, not guesswork. `session.telemetry.marks` holds the raw timeline; `session.telemetry.turns` derives a `TurnLatencySummary` per turn with `responseLatencyMs` (end-of-turn → first agent audio written) and `voiceToVoiceMs` (last caller speech-end → first agent audio written). Pass `telemetry: { sink }` to `Call` to forward every mark elsewhere (metrics, logs, traces).

v1 sets no hard latency budget — the E2E test's mock-provider pipeline measures in single-digit/low-double-digit milliseconds, which confirms the instrumentation works end-to-end, not a real-provider number. See [SPEC.md](SPEC.md)'s Observability section for real-world orientation figures.

## Transport & runtime

A call has two planes with different runtime needs:

- **Control plane** (`call.webhooks.<adapter>`) — ordinary request/response HTTP (the inbound webhook, the outbound-call REST trigger). Runs anywhere, including serverless.
- **Media plane** (`call.media.<adapter>`) — a WebSocket held open for the entire call, carrying low-latency duplex audio. This is a long-lived, stateful connection.

The SDK dictates no host for either. But the media plane's requirement is physics, not preference: serverless functions are request-scoped and duration-capped, and cold starts / mid-call autoscaling can stutter or drop audio. We **recommend** a long-running host (VPS, container, Railway, Fly, Render, or similar) for the media plane — this is a recommendation, not a restriction. A developer who understands the trade-off can run it on serverless anyway.

## Status

**v1.** One reference adapter (Twilio, via raw audio streaming). WebRTC and additional provider adapters are planned but out of scope for v1 (see [SPEC.md](SPEC.md)). Packages are not yet published to npm — use them from within this workspace:

```bash
git clone <this-repo>
pnpm install
pnpm --filter example-twilio-on-ws dev
```

or depend on them via `workspace:*` from another package in this monorepo. Once published, install with `pnpm add call-sdk @call-adapter/twilio @call-adapter/stt-deepgram @call-adapter/tts-elevenlabs`.

## Development

Requires Node >=22.

```bash
pnpm install
pnpm validate    # knip + check + typecheck + test + build
pnpm konsistent  # adapter/stage package shape (.github/konsistent.json)
```

See [AGENTS.md](AGENTS.md) for the full command reference, monorepo layout, and architecture/testing conventions.

## License

MIT

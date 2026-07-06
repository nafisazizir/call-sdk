# Call SDK

[![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

A provider-agnostic SDK for telephony and real-time voice. You decide what happens to a call — answer it, reject it, forward it, send it to voicemail, or take over its raw audio — and the adapter translates that decision into whatever the underlying provider speaks. Call SDK is the voice-native sibling of Vercel's [Chat SDK](https://chat-sdk.dev): where Chat SDK abstracts text chat providers behind one interface, Call SDK abstracts telephony and voice providers behind a consistent set of primitives.

```ts
import { Call } from "call-sdk";
import { createTwilioAdapter } from "@call-adapter/twilio";

const call = new Call({
  adapters: { twilio: createTwilioAdapter() },
});

call.onIncomingCall((incoming) => {
  if (blocklist.has(incoming.from ?? "")) return incoming.reject();
  if (afterHours()) return incoming.forwardTo(ON_CALL_NUMBER);
  return incoming.voicemail({ prompt: "We're unavailable — leave a message." });
});

// call.webhooks.twilio -> mount on any HTTP route. That's the whole app.
```

The core promise is **provider portability**: moving from Twilio to Telnyx is a one-line adapter swap, not a rewrite —

```ts
adapters: { telnyx: createTelnyxAdapter() }, // reject/forwardTo/voicemail/stream unchanged
```

Everything above the adapter — your routing rules, your audio handling, your application — stays identical, because adapters translate decisions into the provider's dialect (TwiML, Call Control, NCCO) and never make them.

## What you build with it

Call SDK is not a voice-AI framework. It is the telephony layer such a framework sits on:

- **Call routing & forwarding** — "after hours, forward to the on-call number." ([`examples/call-router`](examples/call-router), runnable with zero credentials)
- **Screening & blocking** — reject or divert calls from a blocklist.
- **Voicemail** — play a prompt, record a message, hang up.
- **Outbound calls** — `call.dial({ adapter: "twilio", to })` returns a live session.
- **Real-time voice applications, including AI voice agents** — route a call to `stream()`, take over its raw normalized audio, and run your own STT → logic → TTS loop on top. ([`examples/twilio-on-ws`](examples/twilio-on-ws) is the flagship: a full phone agent on the AI SDK)

That last one is *one example consumer, not the SDK's purpose*. The core ships no STT, TTS, turn detection, or LLM coupling — those live in the optional [`@call-adapter/pipeline`](packages/pipeline) layer and the example, never in the core contract.

## How it works

A call has **two planes**:

1. **Control plane** — the inbound webhook and the outbound trigger. Ordinary request/response HTTP; where routing decisions are made. Runs anywhere, including serverless. For a pure router this is the entire runtime footprint.
2. **Media plane (opt-in)** — a WebSocket carrying normalized duplex audio for the call's duration, reached only when a call is routed to `stream()` (or dialed out).

And **three layers**:

1. **Adapters (thin).** An adapter does exactly three things: emit call lifecycle events, execute call-control instructions (translate the SDK's verbs into the provider's dialect), and move normalized audio bidirectionally. It decides nothing and interprets nothing — even when the provider offers managed voice-AI, the adapter is built on the raw audio layer, because managed semantics don't generalize across providers.
2. **Core SDK (`call-sdk`).** `Call`, `CallSession`, the verb set, the lifecycle event model, the normalized audio boundary. Provider-agnostic and semantics-free.
3. **Your application.** A few lines of verbs for a router; `session.audio` + whatever you choose to compose for a voice application.

### The verb set

`onIncomingCall` hands you the call; you return a decision from the handle:

| Verb | Meaning |
| --- | --- |
| `reject(opts?)` | Decline without answering (`{ busy: true }` signals busy). |
| `forwardTo(number, opts?)` | Answer and connect the caller to another number. |
| `voicemail(opts?)` | Optionally play a prompt, record a message, hang up. |
| `say(text, opts?)` / `play(url)` | One-shot provider-TTS / audio prompt, then hang up. (Control-plane `say` is not the interactive media-plane speech a voice app does over `stream()` — the distinction is deliberate.) |
| `stream()` | Hand the call to the media plane: raw audio, a live `CallSession`. |
| `hangup()` | End the call. |

No handler registered → every call streams. A handler that throws or times out → the call is rejected (logged) — never dead air. A verb the adapter can't express fails loudly, never silently.

**Verb-routed calls are fire-and-forget in v1.** Sessions — and the `call-started`/`call-ended` lifecycle — exist exactly for calls that enter the media plane (`stream()` and `dial()`). For `reject`/`forwardTo`/`voicemail`/`say`/`play`/`hangup`, the provider executes the instruction after the webhook response and the SDK's involvement ends there; you observed the call in `onIncomingCall`, where you decided its fate. Tracking those calls end-to-end needs provider status callbacks, which are deliberately out of v1 scope (the design doesn't preclude them).

### The media plane

`stream()` gets you a `CallSession`: a typed event bus, raw canonical audio (`session.audio.frames()` in, `session.audio.write()` out), and the barge-in *mechanism* — `session.audio.clear()` flushes audio already queued on the provider, because stopping generation alone leaves buffered audio playing. When the caller is done speaking, when to interrupt — that's *policy*, and policy is yours (or the optional pipeline's).

Every call ends with **exactly one terminal `call-ended` event**, on every path — hangup, dropped media socket, upstream failure, unhandled error. Consumer cleanup registered via `session.registerCleanup()` runs before it, in reverse registration order. Adapter operations after call end are logged no-ops, not throws.

## The optional voice pipeline

[`@call-adapter/pipeline`](packages/pipeline) is the reference semantic layer for voice applications — stages (VAD, turn detection), `say()` with streaming text, transcript, conversation state, barge-in policy — attached per-call on top of the public core surface:

```ts
import { attachVoice } from "@call-adapter/pipeline";
import { createDeepgramStage } from "@call-adapter/stt-deepgram";
import { createElevenLabsStage } from "@call-adapter/tts-elevenlabs";

call.onIncomingCall((incoming) => incoming.stream());
call.onCallStarted((session) => {
  const voice = attachVoice(session, {
    stages: [createDeepgramStage(), createElevenLabsStage()],
    onEndOfTurn: async (turn, voice) => {
      const { textStream } = streamText({
        model: openai("gpt-5-nano"),
        messages: toModelMessages(voice.transcript),
      });
      await voice.say(textStream);
    },
  });
  void voice.say("Hi! How can I help you today?");
});
```

VAD and turn detection are injected by default; **turn detection ≠ silence detection** — "the audio went quiet" is not "the caller is done speaking," and `end-of-turn` is a distinct, swappable stage. A caller speaking while the agent talks triggers barge-in: TTS is aborted and the provider queue flushed. None of this is in core — a router or plain recorder never pulls it in.

## Packages

| Package | npm name | Role |
| --- | --- | --- |
| [`packages/call-sdk`](packages/call-sdk) | `call-sdk` | **Thin core** — `Call`, `CallSession`, call-control verbs, lifecycle events, normalized audio boundary. No semantics. |
| [`packages/adapter-twilio`](packages/adapter-twilio) | `@call-adapter/twilio` | Twilio adapter: TwiML verb translation + raw Media Streams. |
| [`packages/pipeline`](packages/pipeline) | `@call-adapter/pipeline` | **Optional** voice pipeline: stages, `attachVoice`, `say()`, transcript, barge-in policy. |
| [`packages/stt-deepgram`](packages/stt-deepgram) | `@call-adapter/stt-deepgram` | Optional Deepgram transcription stage (example dependency). |
| [`packages/tts-elevenlabs`](packages/tts-elevenlabs) | `@call-adapter/tts-elevenlabs` | Optional ElevenLabs synthesis stage (example dependency). |
| [`packages/tests`](packages/tests) | `@call-adapter/tests` | Conformance suites (adapter, routing, stage), mocks, and a protocol-accurate fake Twilio client. |
| [`examples/call-router`](examples/call-router) | `example-call-router` | The headline use case: reject/forward/voicemail router, control plane only, no media. |
| [`examples/twilio-on-ws`](examples/twilio-on-ws) | `example-twilio-on-ws` | The flagship voice app: Twilio + Deepgram + ElevenLabs + the AI SDK. |

## Event taxonomy

Core (`CallEventMap` in `call-sdk`) is transport and lifecycle only:

| Event | Meaning |
| --- | --- |
| `call-started` | The media session is live. |
| `call-answered` | The provider reports the call answered / media flowing. |
| `call-ended` | Terminal fact. Fires exactly once, on every teardown path. |
| `audio-frame` | One inbound canonical PCM16/16kHz frame from the adapter. |
| `audio-mark` | The provider echoed a playback mark (`session.audio.mark()`) — playback reached it. |
| `error` | A session-level error (`fatal` gates auto-teardown). |
| `telemetry` | A latency instrumentation mark was recorded. |

The pipeline merges its semantic events into the same map via TypeScript declaration merging when you import it: `speech-start`/`speech-end` (VAD), `transcript-interim`/`transcript-final`/`stt-endpoint` (STT), `end-of-turn` (turn detection), `agent-say` (the sole command event), `audio-out`, `agent-generation-end`, `agent-speech-start`/`agent-speech-end`, `interruption`.

## Canonical audio

Every adapter normalizes to PCM16 mono @ 16 kHz, 20 ms frames on the way in and de-normalizes on the way out. This is load-bearing: it's what lets one consumer configuration (VAD thresholds, STT encoding, TTS output) work identically across every provider.

## Telemetry

The core instruments the media boundary from the first frame (`session.telemetry.marks`, `telemetry: { sink }` on `Call` to forward marks anywhere). The pipeline layers per-turn summaries on top: `voice.turns` derives `responseLatencyMs` (end-of-turn → first agent audio) and `voiceToVoiceMs` (caller speech-end → first agent audio) per turn.

## Transport & runtime

- **Control plane** (`call.webhooks.<adapter>`) — fetch-style `Request → Response`. Runs anywhere, including serverless.
- **Media plane** (`call.media.<adapter>`) — a structural `MediaSocket` handler (`ws` works as-is), one long-lived connection per call.

The SDK dictates no host. But the media plane's requirement is physics: serverless functions are request-scoped and duration-capped, and cold starts / mid-call autoscaling stutter audio. We **recommend** a long-running host (VPS, container, Railway, Fly, Render) for the media plane — a recommendation, not a restriction. Control-plane-only consumers have no such constraint.

## Status

**v1.** One reference adapter (Twilio). Additional adapters (Telnyx, Vonage, WebRTC), DTMF/IVR, and recording retrieval are out of v1 scope by design — the architecture doesn't preclude them. Packages are not yet published to npm — use them from within this workspace:

```bash
git clone <this-repo>
pnpm install
pnpm --filter example-call-router dev   # the router
pnpm --filter example-twilio-on-ws dev  # the voice agent
```

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

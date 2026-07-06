# call-sdk

The **thin core** of [Call SDK](../../README.md), a provider-agnostic SDK for telephony and real-time voice: `Call`, `CallSession`, the call-control verb set, the lifecycle event model, and the normalized audio boundary every adapter is built on. No STT, TTS, turn detection, or semantics — see the [root README](../../README.md) for the big-picture pitch and the flagship example [`examples/twilio-on-ws`](../../examples/twilio-on-ws) for the optional voice pipeline that adds them.

Not yet published — see the [root README's Status section](../../README.md#status) for workspace usage. Once published:

```bash
pnpm add call-sdk
```

## Usage

```ts
import { Call } from "call-sdk";
import { createTwilioAdapter } from "@call-adapter/twilio";

const call = new Call({
  adapters: { twilio: createTwilioAdapter() },
});

call.onIncomingCall((incoming) => {
  if (blocklist.has(incoming.from ?? "")) return incoming.reject();
  if (afterHours()) return incoming.forwardTo(ON_CALL_NUMBER);
  return incoming.stream(); // hand this call to the media plane
});

// call.webhooks.twilio -> mount on any HTTP route (control plane)
// call.media.twilio    -> mount on any WebSocket route (media plane)
```

`new Call({ adapters, logger?, routing?, telemetry? })` is the whole configuration surface: `adapters` maps a name to an `Adapter` instance; `logger` accepts a `Logger` or a `LogLevel` string; `routing.handlerTimeoutMs` bounds how long `onIncomingCall` gets before the call is rejected (default 5000ms); `telemetry.sink` receives every `TelemetryMark` recorded at the media boundary.

## Behavior registration

Behavior is registered with **methods**, not config callbacks — `Call` is constructed once and serves many calls over its lifetime.

`call.onIncomingCall(handler)` is single-slot (throws on a second registration) and is where a call's fate is decided. The handler receives an `IncomingCall` (`adapter`, `callId`, `from?`, `to?`, `raw?`) and returns a decision from one of its verb methods:

| Verb | Meaning |
| --- | --- |
| `reject(opts?)` | Decline without answering (`{ busy: true }` signals busy). |
| `forwardTo(number, opts?)` | Answer and connect the caller to another number. |
| `voicemail(opts?)` | Optionally play a prompt, record a message, hang up. |
| `say(text, opts?)` / `play(url)` | One-shot provider-TTS / audio prompt, then hang up. (Control-plane `say` is not the interactive media-plane speech a voice app does over `stream()` — the distinction is deliberate.) |
| `stream()` | Hand the call to the media plane: raw audio, a live `CallSession`. |
| `hangup()` | End the call. |

No handler registered → every call streams. A handler that throws or times out → the call is rejected (logged) — never dead air. A verb the adapter can't express fails loudly (`AdapterError`), never silently.

The rest of the lifecycle is multi-slot (registration order, late registration works, one throwing handler never blocks the next):

- `call.onCallStarted(session => ...)` — the media session is live.
- `call.onCallAnswered(session => ...)` — the provider reports the call answered / media flowing.
- `call.onCallEnded((event, session) => ...)` — the exactly-once terminal event.
- `call.onError((event, session) => ...)` — session-level errors (`event.fatal` gates auto-teardown).

## Outbound calls

```ts
const session = await call.dial({ adapter: "twilio", to: "+15551234567" });
// resolves once the provider connects media — outbound calls always enter the media plane
```

`dial` rejects after `timeoutMs` (default 30s) if the provider never connects media back.

## The fire-and-forget rule

**Verb-routed calls are fire-and-forget in v1.** Sessions — and the `call-started`/`call-ended` lifecycle — exist exactly for calls that enter the media plane (`stream()` and `dial()`). For `reject`/`forwardTo`/`voicemail`/`say`/`play`/`hangup`, the provider executes the instruction after the webhook responds and the SDK's involvement ends there: you observed the call in `onIncomingCall`, where you decided its fate. **No `CallSession` is created for these calls.** Tracking them end-to-end needs provider status callbacks, deliberately out of v1 scope.

## The media plane

`stream()` (or `dial()`) gets you a `CallSession`:

- `session.bus` — the typed `EventBus<CallEventMap>`; `session.on(type, handler)` is sugar for `session.bus.subscribe`.
- `session.audio` (`SessionAudio`) — the raw canonical audio surface:
  - `frames(): AsyncIterable<AudioFrame>` — inbound audio, one independent iterator per call.
  - `write(frame)` — enqueue outbound audio.
  - `clear()` — the barge-in *mechanism*: flushes audio already queued on the provider (stopping generation alone leaves buffered audio playing).
  - `mark(name)` — request a playback mark; the provider echoes it back as `audio-mark` when playback reaches it (`canMark` reports whether the adapter supports this).
- `session.signal` — an `AbortSignal` aborted when teardown starts.
- `session.registerCleanup(fn)` — consumer cleanup, run in reverse registration order before the terminal event.
- `session.ended` — a promise that resolves with the terminal `call-ended` payload; never rejects.

Every call ends with **exactly one terminal `call-ended` event**, on every path — hangup, dropped media socket, upstream failure, unhandled error. Adapter operations after call end (`write`/`clear`/`deliverAudio`) are logged no-ops, not throws.

```ts
call.onCallStarted(async (session) => {
  for await (const frame of session.audio.frames()) {
    // your own VAD / STT / turn logic here
    session.audio.write(frame); // e.g. echo it straight back
  }
});
```

Deciding *when* the caller is done speaking, and *when* to interrupt, is policy — that's the optional voice pipeline's job, not core's. This package stops at the mechanism.

## Mountable handlers

- `call.webhooks.<adapter>` — fetch-style `(request: Request, options?) => Promise<Response>`. Runs anywhere, including serverless.
- `call.media.<adapter>` — a structural `(socket: MediaSocket) => void` handler, one long-lived connection per call. `MediaSocket` only requires `addEventListener("message"/"close"/"error")`, `send`, and `close`, so the `ws` package's `WebSocket` satisfies it as-is.

## Canonical audio

Every adapter normalizes to PCM16 mono @ 16kHz, 20ms frames (`CANONICAL_FORMAT`, 320 samples/frame) on the way in and de-normalizes on the way out. Load-bearing: it's what lets one consumer configuration work identically across every provider.

## Semantics live elsewhere

`call-sdk` ships no VAD, transcription, turn detection, `say()`, transcript, or conversation state — those live in the optional voice pipeline (example source in [`examples/twilio-on-ws`](../../examples/twilio-on-ws)), built entirely on the public surface above (`session.bus`, `session.audio`, `session.telemetry`). A call router or plain recorder never needs to import it.

## What's exported

- **App/session:** `Call`, `CallConfig`, `DialOptions`, `Webhooks`, `MediaHandlers`, `CallSession`, `CallSessionDeps`, `SessionLifecycleHandlers`, `SessionAudio`.
- **Call-control routing:** `IncomingCall`, `IncomingCallHandler`, `IncomingCallInit`, `RoutingAction`, `RoutingDecision`, `isRoutingDecision`, `ROUTING_DECISION_KIND`.
- **Event bus + taxonomy:** `EventBus`, `EventBusOptions`, `EventMeta`, `Unsubscribe`, `CallEventMap`, `CallEventType`, `CallEndReason`, `CORE_CALL_EVENT_TYPES`.
- **Contracts for adapter authors:** `Adapter`, `AdapterContext`, `AdapterDialOptions`, `AdapterSessionHandle`, `MediaSocket`, `MediaSocketCloseEvent`, `MediaSocketMessageEvent`, `mediaSocketDataToText`, `OutboundAudio`, `SessionInit`, `WebhookOptions`, `formatSessionId`/`parseSessionId`.
- **Audio primitives:** `CANONICAL_FORMAT`, `AudioFrame`, `FrameChunker`/`FrameChunkerOptions` (re-chunks arbitrary-length PCM16 into fixed-size frames), `frameDurationMs`, `bytesToInt16`/`int16ToBytes`, `mulawEncode`/`mulawDecode`, `downsampleX2`/`upsampleX2`.
- **Telemetry:** `SessionTelemetry`, `TelemetryMark`, `TelemetrySink` — see the [root README's Telemetry section](../../README.md#telemetry).
- **Errors:** `CallSdkError` and its subclasses `CallConfigError`, `AdapterError`, `AudioFormatError`.
- **Logging:** `Logger`, `LogLevel`, `LogFields`, `ChildLoggerBindings`, `createLogger`, `childLogger`, `ConsoleLogger`.

Building an adapter? Start with `@call-adapter/tests`' `adapterContract`/`routingContract` conformance suites, which exercise this package's `Adapter` contract — transport/lifecycle and per-verb translation — end-to-end.

# call-sdk

Core SDK for [Call SDK](../../README.md) — `Call`, `CallSession`, the typed event bus, the default audio processing pipeline, and the audio primitives every adapter/stage is built on. This is the "chat" of Chat SDK's voice sibling. See the [root README](../../README.md) for the big-picture pitch, event taxonomy, and core promises; this doc covers the package's own surface.

Not yet published — see the [root README's Status section](../../README.md#status) for workspace usage. Once published:

```bash
pnpm add call-sdk
```

## Usage

```ts
import { createTwilioAdapter } from "@call-adapter/twilio";
import { createDeepgramStage } from "@call-adapter/stt-deepgram";
import { createElevenLabsStage } from "@call-adapter/tts-elevenlabs";
import { Call } from "call-sdk";

const call = new Call({
  adapters: { twilio: createTwilioAdapter() },
  stages: [createDeepgramStage(), createElevenLabsStage()],
  onCallStarted: (session) => void session.say("Hi! How can I help you today?"),
  onEndOfTurn: async (turn, session) => {
    await session.say(`You said: ${turn.transcript}`);
  },
});

// call.webhooks.twilio(request) -> Response   (control plane, any HTTP host)
// call.media.twilio(socket)                    (media plane, any WebSocket host)
```

`call-sdk` ships two default stages so the pipeline works with zero stage config beyond STT/TTS: `createEnergyVadStage()` (raw voice-activity detection) and `createSilenceTurnStage()` (silence-threshold turn detection). Both are auto-injected by `Call` unless your own stages already emit `speech-start`/`end-of-turn` — pass your own to override either.

## Two entry points, one graph

- **High-level:** the `CallConfig` handlers (`onCallStarted`, `onEndOfTurn`, `onTranscript`, `onInterruption`, `onError`, `onCallEnded`) plus `session.say(text)` — a `string` or `AsyncIterable<string>` (an AI SDK `textStream` pipes straight in, sentence-chunked so synthesis starts on the first sentence). Resolves with `{ interrupted, utteranceId }` once playback completes or is cut off.
- **Low-level:** `session.bus` / `session.on(type, handler)` — the same per-session `EventBus<CallEventMap>` every stage subscribes to. Subscribe directly for your own transcriber, turn model, or VAD:

  ```ts
  session.on("transcript-final", (event) => { /* ... */ });
  session.bus.publish("agent-say", { utteranceId, text, signal });
  ```

## What's exported

- **App/session:** `Call`, `CallConfig`, `CallSession`, `SessionHandlers`, `SayResult`, `ConversationState`, `TranscriptEntry`.
- **Event bus + taxonomy:** `EventBus`, `CallEventMap`, `CallEventType`, `CallEndReason`, `TranscriptFinalEvent`.
- **Contracts for adapter/stage authors:** `Adapter`, `AdapterContext`, `AdapterSessionHandle`, `MediaSocket`, `OutboundAudio`, `Stage`, `StageContext`, `StageHandle`, `formatSessionId`/`parseSessionId`.
- **Graph validation:** `validateStageGraph`, `CORE_PRODUCED_EVENTS` — used internally by `Call`, exported so adapter/stage packages can validate their own wiring in tests.
- **Default stages:** `createEnergyVadStage`/`EnergyVadStage`, `createSilenceTurnStage`/`SilenceTurnStage`.
- **Audio primitives:** `CANONICAL_FORMAT` (PCM16 mono @ 16kHz, 20ms frames), `AudioFrame`, `FrameChunker` (re-chunks arbitrary-length PCM16 into fixed-size frames), `bytesToInt16`/`int16ToBytes`, `mulawEncode`/`mulawDecode`, `downsampleX2`/`upsampleX2`, `frameRms`/`rmsToDbfs`, `chunkSentences`/`toSentenceIterable` (streams text into sentence-sized chunks for low-latency TTS).
- **Telemetry:** `SessionTelemetry`, `TelemetryMark`, `TelemetrySink`, `TurnLatencySummary` (`responseLatencyMs`, `voiceToVoiceMs` per turn) — see the [root README's Telemetry section](../../README.md#telemetry).
- **Errors:** `CallSdkError` and its subclasses `CallConfigError`, `AdapterError`, `StageError`, `AudioFormatError`.
- **Logging:** `Logger`, `LogLevel`, `createLogger`, `childLogger`, `ConsoleLogger`.

Building an adapter or stage? Start with `@call-adapter/tests`' `adapterContract`/`stageContract` conformance suites, which exercise this package's `Adapter`/`Stage` contracts end-to-end.

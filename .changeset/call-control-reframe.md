---
"call-sdk": minor
"@call-adapter/twilio": minor
"@call-adapter/pipeline": minor
"@call-adapter/stt-deepgram": minor
"@call-adapter/tts-elevenlabs": minor
"@call-adapter/tests": minor
---

The call-control reframe: Call SDK is now a provider-agnostic telephony + voice SDK whose core is call control + lifecycle + normalized audio. The AI voice pipeline moved out of core into the new optional `@call-adapter/pipeline` package.

**New: call-control routing.** `call.onIncomingCall((incoming) => ...)` decides every inbound call's fate — `reject()` / `forwardTo(number)` / `voicemail({ prompt })` / `say(text)` / `play(url)` / `stream()` / `hangup()` — and the adapter translates the decision to the provider dialect (TwiML for Twilio, including the mandatory `<Record action>` continuation). No handler → every call streams (previous behavior). Handler error/timeout → reject, logged. Verb-routed calls are fire-and-forget: sessions and the `call-started`/`call-ended` lifecycle exist exactly for media-plane calls (`stream()` / `dial()`).

**Breaking — migration:**

| Before | After |
| --- | --- |
| `new Call({ onCallStarted, onCallEnded, onError, ... })` | Methods: `call.onCallStarted(h)`, `call.onCallEnded(h)`, `call.onError(h)`, `call.onCallAnswered(h)` |
| `new Call({ stages, interruption, onEndOfTurn, onTranscript, onInterruption })` | `attachVoice(session, { stages, interruption, onEndOfTurn, ... })` from `@call-adapter/pipeline`, called synchronously in `call.onCallStarted` |
| `call.startCall("twilio", { to })` | `call.dial({ adapter: "twilio", to })` |
| `session.say()` / `session.transcript` / `session.state` / `session.stopSpeaking()` | `voice.say()` / `voice.transcript` / `voice.state` / `voice.stopSpeaking()` on the `VoiceSession` returned by `attachVoice` |
| `session.telemetry.turns` | `voice.turns` (or `computeTurnLatency(session.telemetry.marks)`) |
| `Stage`, `StageContext`, `StageHandle`, `StageError`, `validateStageGraph`, `resolveStages`, `createEnergyVadStage`, `createSilenceTurnStage`, `chunkSentences`, `frameRms` from `call-sdk` | Same names from `@call-adapter/pipeline` |
| Semantic events in core `CallEventMap` | Merged in by importing `@call-adapter/pipeline` (declaration merging); they flow on `voice.bus` |
| `Adapter.startCall` / `StartCallOptions` | `Adapter.dial` / `AdapterDialOptions`; `AdapterContext` gained `routeIncomingCall` (adapters must call it between webhook parse and response) |

**New core surface:** `session.audio` (`frames()` / `write()` / `clear()` / `mark()`, all post-end-safe), `session.signal`, `session.registerCleanup()` (runs before the terminal `call-ended`, reverse order), `audio-mark` event, `CORE_CALL_EVENT_TYPES`.

**Test kit:** `routingContract` (per-verb translation conformance), `FakeTwilioCall` control-plane-only responses (`connected: false` + parsed TwiML instead of throwing on verb-routed calls), `parseTwiml`, `direction`/`extraParams` options.

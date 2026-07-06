# @call-adapter/pipeline

The **optional** voice pipeline for [Call SDK](https://github.com/vercel-labs/call-sdk): everything a real-time voice application needs on top of the core's raw media plane — pipeline stages (VAD, turn detection), `say()` with streaming text, a conversation transcript, the idle/user-speaking/agent-speaking state machine, and barge-in policy.

None of this is part of the SDK core contract. The core stops at call control and normalized audio; this package is one way — the reference way — to build voice semantics above it. A call router or plain recorder never pulls it in.

## Usage

```ts
import { Call } from "call-sdk";
import { createTwilioAdapter } from "@call-adapter/twilio";
import { attachVoice } from "@call-adapter/pipeline";
import { createDeepgramStage } from "@call-adapter/stt-deepgram";
import { createElevenLabsStage } from "@call-adapter/tts-elevenlabs";

const call = new Call({ adapters: { twilio: createTwilioAdapter() } });

call.onIncomingCall((incoming) => incoming.stream()); // opt into the media plane

call.onCallStarted((session) => {
  // Attach synchronously (before any await) so no audio is missed.
  const voice = attachVoice(session, {
    stages: [createDeepgramStage(), createElevenLabsStage()],
    interruption: { minSpeechMs: 500 },
    onEndOfTurn: async (turn, voice) => {
      await voice.say(`You said: ${turn.transcript}`);
    },
  });
  void voice.say("Hi! How can I help?");
});
```

`attachVoice` validates the stage graph synchronously (miswiring throws at attach time, not mid-call), attaches stages in the background while inbound audio is buffered, and queues `say()` calls until the graph is live. It builds exclusively on the session's public surface (`session.bus`, `session.audio`, `session.telemetry`) — proof the core boundary is sufficient.

## What's in the box

- **`attachVoice(session, options)` → `VoiceSession`** — `say()` (string or streaming text, sentence-chunked), `stopSpeaking()`, `transcript`, `state`, `turns` (per-turn latency), `bus`, `detach()`.
- **Default stages** — `createEnergyVadStage()` (adaptive energy-gate VAD) and `createSilenceTurnStage()` (silence-hangover turn detection), auto-injected unless your stages already cover the role.
- **The `Stage` contract** — `create${Name}Stage(config)` factories with declared `consumes`/`emits`, validated as a graph. `@call-adapter/stt-deepgram` and `@call-adapter/tts-elevenlabs` implement it.
- **Semantic events** — `transcript-*`, `end-of-turn`, `speech-*`, `agent-say`, `interruption`, ... merged into core's `CallEventMap` by declaration merging when you import this package.
- **Barge-in** — the pipeline detects caller speech during agent playback, publishes `interruption`, aborts TTS, and flushes the provider queue via the core's `clear()` mechanism. Policy lives here; the mechanism stays in core.
- **Mock stages for tests** — `createMockSttStage`/`createMockTtsStage`, deterministic scripted stages for testing a full voice loop with zero credentials.

## Teardown

`VoiceSession` registers itself with `session.registerCleanup(...)`: at call teardown the stage graph is disposed (reverse attach order, provider sockets closed) *before* the terminal `call-ended` event, which is still forwarded onto `voice.bus` afterwards. `detach()` does the same manually without ending the call.

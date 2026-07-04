# @call-adapter/tests

Shared Vitest factories, matchers, and conformance suite for testing [Call SDK](../../README.md) adapters and pipeline stages against one common contract, mirroring `@chat-adapter/tests`. This is the toolkit to reach for when building a new `@call-adapter/*` package, or testing an agent built on `call-sdk`.

Not yet published — see the [root README's Status section](../../README.md#status) for workspace usage. Once published:

```bash
pnpm add -D @call-adapter/tests
```

This package has `call-sdk` and `vitest` as peer dependencies — they should already be in your project.

## Conformance suites

Run these against your own adapter/stage to verify it honors the shared contract, not just your own hand-picked test cases:

```ts
import { adapterContract, stageContract } from "@call-adapter/tests";

adapterContract("my-provider", () => createMyAdapter(), {
  openSession: (call, adapter) => { /* drive a session from the provider side */ },
});

stageContract("my-stage", () => createMyStage(), {
  consumes: ["audio-frame"],
  emits: ["speech-start", "speech-end"],
  // ... drive the stage's declared consumes, assert its declared emits
});
```

`adapterContract` asserts session ids are well-formed and round-trippable (`${adapter.name}:${callId}`) and that handle calls (`deliverAudio`/`answered`/`mark`) are safe no-ops after teardown, with `call-ended` firing exactly once. `stageContract` asserts a stage's actual bus traffic matches its declared `consumes`/`emits`.

## Mocks and factories

```ts
import {
  createMockAdapter,
  createMockLogger,
  createMockSttStage,
  createMockTtsStage,
} from "@call-adapter/tests";
```

- **`createMockAdapter(name?, overrides?)`** — an `Adapter` with every method as `vi.fn()` and sensible defaults, plus a `connectCall()` driver (`MockCallDriver`) for simulating provider-side session start/audio/hangup without a real socket.
- **`createMockSttStage({ script })`** — a `Stage` that plays back a scripted sequence of `transcript-interim`/`transcript-final`/`stt-endpoint` events (`MockSttScriptEntry[]`) instead of hitting a real STT provider.
- **`createMockTtsStage(config?)`** — a `Stage` that turns `agent-say` into synthetic `audio-out` frames + `agent-generation-end`, without a real TTS provider.
- **`createMockLogger()`** — a `Logger` that records entries (`.entries`) for assertions instead of writing to the console.

## `FakeTwilioCall`

A protocol-accurate fake Twilio client for end-to-end adapter tests — signs and POSTs the inbound webhook (`computeFakeTwilioSignature`), opens the media WebSocket, and streams paced μ-law audio frames exactly like a real Twilio call would:

```ts
import { startFakeTwilioCall } from "@call-adapter/tests";

const fakeCall = await startFakeTwilioCall({
  webhookUrl: "http://localhost:3000/twilio/voice",
  mediaUrl: "ws://localhost:3000/twilio/media",
  authToken: "test-auth-token",
});
await fakeCall.sendAudio(toneFrames(500)); // paced, real-time-like playback
await fakeCall.hangup();
```

See `examples/twilio-on-ws/src/e2e.test.ts` for the full pattern: a real `Call`/adapter wiring driven end-to-end through `FakeTwilioCall`, with only the STT/TTS provider edges mocked.

## Matchers and event recording

```ts
import { matchers, recordEvents, toBeCanonicalFrame } from "@call-adapter/tests";

expect.extend(matchers);

const recorded = recordEvents(session.bus); // records every published event, in order
// ... drive the session ...
expect(recorded).toHaveEmitted("end-of-turn");
expect(recorded).toHaveEndedOnce(); // exactly one call-ended
expect(frame).toBeCanonicalFrame(); // PCM16 mono @ 16kHz, correct sample count
```

`ALL_CALL_EVENT_TYPES` lists every `CallEventType`, handy for asserting a recorder or mock covers the full taxonomy.

## Audio fixtures

`silenceFrames(ms)`, `toneFrames(ms, opts?)`, and `concatFrames(...groups)` build canonical `AudioFrame[]` sequences for feeding into adapters/stages under test without recording real audio.

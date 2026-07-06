# @call-adapter/tests

Shared Vitest factories, matchers, and conformance suites for testing [Call SDK](../../README.md) adapters and pipeline stages against one common contract, mirroring `@chat-adapter/tests`. This is the toolkit to reach for when building a new `@call-adapter/*` package, or testing an agent built on `call-sdk`.

Not yet published — see the [root README's Status section](../../README.md#status) for workspace usage. Once published:

```bash
pnpm add -D @call-adapter/tests
```

This package has `call-sdk` and `vitest` as peer dependencies — they should already be in your project.

## Conformance suites

Run these against your own adapter/stage to verify it honors the shared contract, not just your own hand-picked test cases:

```ts
import { adapterContract, routingContract, stageContract } from "@call-adapter/tests";

adapterContract("my-provider", () => createMyAdapter(), {
  openSession: (call, adapter) => { /* drive a session from the provider side */ },
});

routingContract("my-provider", () => createMyAdapter(), {
  makeInboundRequest: () => new Request("http://localhost/voice", { method: "POST", body: "..." }),
  expectTranslated: {
    reject: (response) => { /* assert response.body looks like a reject in your dialect */ },
    forward: (response) => { /* ... */ },
    // say / play / voicemail / hangup / stream — cover whichever verbs your adapter supports
  },
});

stageContract("my-stage", () => createMyStage(), {
  arrange: (bus) => bus.publish("audio-frame", { frame }),
  expectEmits: ["speech-start", "speech-end"],
});
```

- **`adapterContract`** — transport/lifecycle-only: asserts session ids are well-formed and round-trippable (`${adapter.name}:${callId}`) and that handle calls (`deliverAudio`/`answered`/`mark`) are safe no-ops after teardown, with `call-ended` firing exactly once.
- **`routingContract`** — per-verb translation conformance. Instantiate this for every adapter you build: it drives `onIncomingCall` through each verb (`reject`/`forward`/`say`/`play`/`voicemail`/`hangup`/`stream`) via a real inbound webhook request and asserts your adapter's response, plus the two decisions core makes without a handler (default-stream, handler-throws-reject). Adapters translate verbs, they never decide — this is what proves it.
- **`stageContract`** — asserts a stage's actual bus traffic matches its declared `consumes`/`emits`, and that it goes silent after `dispose()`.

## Mocks and factories

```ts
import { createMockAdapter, createMockLogger } from "@call-adapter/tests";
```

- **`createMockAdapter(name?, overrides?)`** — an `Adapter` with a working call-control webhook (parses `CallSid`/`From`/`To`, calls `routeIncomingCall`, and responds with the raw `RoutingDecision` JSON — no provider dialect in the way) plus a `connectCall()` driver (`MockCallDriver`) for simulating provider-side media session start/audio/hangup without a real socket.
- **`createMockLogger()`** — a `Logger` that records entries (`.entries`) for assertions instead of writing to the console.

Mock STT/TTS stages (`createMockSttStage`, `createMockTtsStage`, `MockSttScriptEntry`) now live in [`@call-adapter/pipeline`](../pipeline) — this package re-exports them for convenience, so `import { createMockSttStage } from "@call-adapter/tests"` still works.

## `FakeTwilioCall`

A protocol-accurate fake Twilio *client* for end-to-end adapter tests — signs and POSTs the inbound webhook (`computeFakeTwilioSignature`), then, if the response opens a media stream, connects the WebSocket and drives the full wire protocol (`connected`/`start`, paced μ-law audio, marks, `stop`):

```ts
import { startFakeTwilioCall } from "@call-adapter/tests";

const fakeCall = await startFakeTwilioCall({
  baseUrl: "http://localhost:3000", // host running the adapter's webhook + media handlers
  webhookPath: "/twilio/voice", // default
  direction: "inbound", // or "outbound"
  extraParams: { CallStatus: "ringing" }, // merged into the webhook body, overriding defaults
});

await fakeCall.speak({ kind: "tone", ms: 500 }); // paced, real-time-like inbound audio
await fakeCall.hangup();
```

`connected` is `false` for a **control-plane-only** response — `reject`/`forward`/`say`/`play`/`hangup`/voicemail's `<Record>` all answer with call-control TwiML, not `<Connect><Stream>`, so no media WebSocket is ever opened; `speak`/`sendStop`/`hangup`/`close` become no-ops and `closed` resolves immediately. In that case, inspect `fakeCall.twimlResponse` (`{ status, body }`) directly — that's the whole test.

`parseTwiml(body)` parses a TwiML `<Response>` document into a `TwimlVerb[]` tree (`tag`/`attributes`/`children`/`text`), one level of nesting resolved (e.g. `<Dial><Number>...</Number></Dial>`) — handy for asserting on TwiML shape without string-matching:

```ts
import { parseTwiml } from "@call-adapter/tests";

const [verb] = parseTwiml(fakeCall.twimlResponse.body);
expect(verb.tag).toBe("Reject");
expect(verb.attributes.reason).toBe("busy");
```

See `examples/twilio-on-ws/src/e2e.test.ts` and `examples/call-router/src/e2e.test.ts` for the full patterns: a real `Call`/adapter wiring driven end-to-end through `FakeTwilioCall`, with only the STT/TTS provider edges mocked.

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

# @call-adapter/tests

Shared Vitest factories, matchers, and conformance suites for testing [Call SDK](../../README.md) adapters against one common contract. This is the toolkit to reach for when building a new `@call-adapter/*` adapter, or testing an agent built on `call-sdk`. It depends only on `call-sdk` — the voice pipeline and its `stageContract` live with the example that owns them (`examples/twilio-on-ws/src/pipeline`).

Not yet published — see the [root README's Status section](../../README.md#status) for workspace usage. Once published:

```bash
pnpm add -D @call-adapter/tests
```

This package has `call-sdk` and `vitest` as peer dependencies — they should already be in your project.

## Conformance suites

Run these against your own adapter/stage to verify it honors the shared contract, not just your own hand-picked test cases:

```ts
import { adapterContract, routingContract } from "@call-adapter/tests";

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
```

- **`adapterContract`** — transport/lifecycle-only: asserts session ids are well-formed and round-trippable (`${adapter.name}:${callId}`) and that handle calls (`deliverAudio`/`answered`/`mark`) are safe no-ops after teardown, with `call-ended` firing exactly once.
- **`routingContract`** — per-verb translation conformance. Instantiate this for every adapter you build: it drives `onIncomingCall` through each verb (`reject`/`forward`/`say`/`play`/`voicemail`/`hangup`/`stream`) via a real inbound webhook request and asserts your adapter's response, plus the two decisions core makes without a handler (default-stream, handler-throws-reject). Adapters translate verbs, they never decide — this is what proves it.

(The `stageContract` suite for the optional voice pipeline lives in `examples/twilio-on-ws/src/pipeline/testing`, alongside the `Stage` contract it checks.)

## Mocks and factories

```ts
import { createMockAdapter, createMockLogger } from "@call-adapter/tests";
```

- **`createMockAdapter(name?, overrides?)`** — an `Adapter` with a working call-control webhook (parses `CallSid`/`From`/`To`, calls `routeIncomingCall`, and responds with the raw `RoutingDecision` JSON — no provider dialect in the way) plus a `connectCall()` driver (`MockCallDriver`) for simulating provider-side media session start/audio/hangup without a real socket.
- **`createMockLogger()`** — a `Logger` that records entries (`.entries`) for assertions instead of writing to the console.

Mock STT/TTS stages (`createMockSttStage`, `createMockTtsStage`) live with the voice pipeline in `examples/twilio-on-ws/src/pipeline/testing` — they exercise the `Stage` contract, which is not part of this kit's (adapter-only) surface.

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

## `FakeTelnyxCall`

A protocol-accurate fake Telnyx *client* for end-to-end adapter tests. Telnyx Call Control v2 is asynchronous — the adapter acks the inbound webhook with a bare 200 and issues call-control commands as `POST {apiBaseUrl}/v2/calls/{ccid}/actions/{command}`, and multi-step verbs advance when Telnyx emits consequence webhooks — so the fake comes in two pieces:

- **`startFakeTelnyxApi`** — a stand-in for Telnyx's REST API on `node:http`. It records every command the adapter issues (`commands` / `commandsFor(ccid)` / `waitForCommand(pred)`), answers `200 {"data":{"result":"ok"}}`, and (via the `webhookSink` you pass) emits the consequence webhook that drives the next step — `answer` → `call.answered`, `speak` → `call.speak.ended`, `playback_start` → `call.playback.ended`, `record_start` → `call.recording.saved`, `reject`/`transfer`/`hangup` → `call.hangup` — echoing the command's base64 `client_state` back onto every emitted payload, exactly as Telnyx threads it.
- **`startFakeTelnyxCall`** — signs and delivers the `call.initiated` webhook (Ed25519, via `createFakeTelnyxKeys` / `buildSignedTelnyxWebhook`), inspects the commands the adapter issued in response, and — if it answered with inline stream params (`stream_url`) — connects the media WebSocket and drives the Telnyx media wire protocol (`connected`/`start`, paced L16 or PCMU audio, marks, `stop`).

```ts
import { startFakeTelnyxApi, startFakeTelnyxCall } from "@call-adapter/tests";

// Create the fake API *first* so the adapter's `apiBaseUrl` can point at it.
const api = await startFakeTelnyxApi({
  webhookSink: (event) => deliverWebhookToAdapter(event), // sign + POST back
});
const adapter = createTelnyxAdapter({ apiBaseUrl: api.baseUrl /* ... */ });

const call = await startFakeTelnyxCall({
  api,
  webhook: (req) => call.webhooks.telnyx(req), // or `webhookUrl: "http://localhost:3000/telnyx/webhook"`
  codec: "L16", // or "PCMU"
});

await call.speak({ kind: "tone", ms: 500 }); // paced, real-time-like inbound audio
await call.hangup();
```

`connected` is `false` for a **control-plane-only** outcome — reject/transfer/hangup, or an `answer` without `stream_url` — so no media WebSocket is opened and `speak`/`sendStop`/`hangup`/`close` become no-ops. Inspect `call.webhookResponse` (`{ status, body }`) and the recorded commands directly in that case:

```ts
const [reject] = api.commandsFor(call.callControlId);
expect(reject.command).toBe("reject");
```

`decodeTelnyxClientState(s)` (base64 → `JSON.parse`, `undefined` on failure) unwraps a command's `client_state` for assertions. Like `FakeTwilioCall`, this module reproduces Telnyx's crypto and wire protocol independently rather than importing the adapter — the kit stays adapter-agnostic.

## Matchers and event recording

```ts
import { matchers, recordEvents, toBeCanonicalFrame } from "@call-adapter/tests";

expect.extend(matchers);

const recorded = recordEvents(session.bus); // records core transport/lifecycle events, in order
// ... drive the session ...
expect(recorded).toHaveEmitted("call-answered");
expect(recorded).toHaveEndedOnce(); // exactly one call-ended
expect(frame).toBeCanonicalFrame(); // PCM16 mono @ 16kHz, correct sample count
```

`recordEvents` subscribes to the core taxonomy (`CORE_CALL_EVENT_TYPES`) by default; pass a second argument to record an extended set — e.g. the example's pipeline testing module wraps it with the full pipeline taxonomy so `end-of-turn`/`interruption`/etc. are captured too.

## Audio fixtures

`silenceFrames(ms)`, `toneFrames(ms, opts?)`, and `concatFrames(...groups)` build canonical `AudioFrame[]` sequences for feeding into adapters/stages under test without recording real audio.

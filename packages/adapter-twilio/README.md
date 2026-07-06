# @call-adapter/twilio

Twilio telephony adapter for [Call SDK](../../README.md) — translates the SDK's call-control verbs into TwiML, normalizes Twilio's raw Media Streams audio to and from the SDK's canonical PCM16/16kHz format, and emits call lifecycle events. Built on Twilio's raw audio streaming layer, not its managed voice-AI product: this adapter contains no VAD, transcription, or turn logic — see the [root README](../../README.md#how-it-works) for why that split matters.

Not yet published — see the [root README's Status section](../../README.md#status) for workspace usage. Once published:

```bash
pnpm add @call-adapter/twilio
```

## Usage

```ts
import { Call } from "call-sdk";
import { createTwilioAdapter } from "@call-adapter/twilio";

const call = new Call({
  adapters: {
    twilio: createTwilioAdapter({
      // All fields are optional and resolved lazily; see the config table below.
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
      phoneNumber: process.env.TWILIO_PHONE_NUMBER,
    }),
  },
});

call.onIncomingCall((incoming) => incoming.stream());

// Control plane (any HTTP host):
//   POST /twilio/voice -> call.webhooks.twilio(request)
// Media plane (any WebSocket host, held open for the call's duration):
//   upgrade /twilio/media -> call.media.twilio(socket)
```

Mounting on a plain `node:http` + `ws` server — the two routes above translate to:

```ts
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/twilio/voice") {
    // adapt `req` to a WHATWG Request, call call.webhooks.twilio(request),
    // write the Response back — see examples/twilio-on-ws/src/app.ts
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio/media") {
    wss.handleUpgrade(req, socket, head, (ws) => call.media.twilio(ws));
  }
});
```

See [`examples/twilio-on-ws`](../../examples/twilio-on-ws) for the complete, runnable wiring (including the `node:http` ↔ WHATWG `Request`/`Response` adapter glue), and [`examples/call-router`](../../examples/call-router) for a control-plane-only router with no media at all.

## Config (`TwilioAdapterConfig`)

Every field is optional; resolution is lazy — nothing throws at construction, only when a value is actually needed (validating a signature, placing an outbound call). The adapter type-checks and wires into `Call` with zero Twilio credentials in the environment.

| Field | Default | Notes |
| --- | --- | --- |
| `accountSid` | `process.env.TWILIO_ACCOUNT_SID` | Required by `dial`. |
| `authToken` | `process.env.TWILIO_AUTH_TOKEN` | Required for signature validation and `dial`. |
| `phoneNumber` | `process.env.TWILIO_PHONE_NUMBER` | Default `from` number for `dial`. |
| `mediaPath` | `"/twilio/media"` | Path the media WebSocket is mounted on. |
| `mediaUrl` | derived from the webhook's `Host` header | The `wss://` URL Twilio dials for media. Inbound calls can derive it; outbound calls have no inbound request to derive it from, so it's **required** for `dial`. |
| `apiBaseUrl` | `"https://api.twilio.com"` | Overridable for tests (point at a fake local server). |
| `validateSignature` | `true` iff an auth token is configured | Whether inbound webhooks validate `X-Twilio-Signature`. |

## The adapter's three duties

Like every `Adapter`, this one does exactly three things — nothing more:

1. **Emit call lifecycle events.** The webhook and media handlers turn Twilio's raw signals (`start`/`stop`, socket close/error) into `call-started`/`call-answered`/`call-ended`.
2. **Execute call-control instructions.** The webhook calls `ctx.routeIncomingCall(init)`, then translates the returned `RoutingDecision` into TwiML — pure translation; the adapter never decides a call's fate.
3. **Move normalized audio bidirectionally.** μ-law/8kHz ⇄ PCM16/16kHz via `mulawDecode`/`mulawEncode` + `upsampleX2`/`downsampleX2` from `call-sdk`, plus the outbound `clear()`/`mark()` operations that make barge-in and precise playback-completion detection work.

No VAD, transcription, or turn detection lives here — those are pipeline stages, always above the adapter.

## Verb → TwiML translation

`routingDecisionTwiml` (`src/twiml.ts`) translates each routing action returned from `onIncomingCall` into one `<Response>`:

| Verb | TwiML |
| --- | --- |
| `reject(opts?)` | `<Reject reason="rejected\|busy"/>` |
| `forwardTo(number, opts?)` | `<Dial><Number>...</Number></Dial>` |
| `say(text, opts?)` | `<Say voice="..." language="...">text</Say>` |
| `play(url)` | `<Play>url</Play>` |
| `voicemail(opts?)` | `<Say>prompt</Say>` (if a prompt was given), then `<Record action="...">` |
| `hangup()` | `<Hangup/>` |
| `stream()` | `<Connect><Stream>` (built by `connectStreamTwiml`, not `routingDecisionTwiml` — it's the media-plane hand-off, not a standalone action) |

Composed verbs (`voicemail` = `say` + `record`) translate as a single `<Response>` containing each action's TwiML in order. An action this adapter can't express throws `AdapterError` (webhook → 500) — loudly, never a silent drop.

## The `<Record action>` continuation

`<Record>`'s `action` URL is **mandatory**, not cosmetic: without it, Twilio re-requests the original webhook once recording ends, which re-runs routing from scratch — an infinite voicemail loop instead of a hangup. The adapter sets it to the same webhook URL with `?call_sdk_action=hangup` appended.

When that continuation request arrives, the webhook validates `X-Twilio-Signature` first (same as any other request), then short-circuits straight to `<Hangup/>` **before** calling `routeIncomingCall` again. This is a mechanical completion of a decision already made — not a new routing decision — so `onIncomingCall` never re-runs for it. There is no recording-retrieval API in v1: the adapter hangs up after recording, it doesn't fetch or expose the recording itself.

## Media protocol and audio normalization

The adapter owns the Media Streams wire protocol for one connection: `connected`/`start` bring the session up (caller `from`/`to`/`direction` ride along as `<Parameter>` children of `<Connect><Stream>`, since Twilio's `start` message doesn't otherwise carry them — the adapter reads them back from `start.customParameters`), `media` frames flow bidirectionally, `mark` echoes drive playback-completion detection, and `stop`/socket-close/error all end the call exactly once. A dropped media socket ends the call in v1 (no mid-call reconnection). Adapter operations after call end (`write`/`clear`) are safe no-ops.

## Outbound calls

`dial({ adapter: "twilio", to })` (via `Call.dial`) places an outbound call through Twilio's REST API and connects it to the same `<Connect><Stream>` media plane as an inbound call — `config.mediaUrl` is required since there's no inbound request to derive it from.

## Also exported

For advanced use (custom media hosts, tests): `parseTwilioMessage`, `connectStreamTwiml`, `startTwilioCall`, `computeTwilioSignature`/`validateTwilioSignature`, and the `TwilioInboundMessage`/`TwilioStartMessage`/`TwilioMediaMessage`/`TwilioMarkMessage`/`TwilioStopMessage`/`TwilioConnectedMessage` protocol types.

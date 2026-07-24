# @call-adapter/telnyx

Telnyx telephony adapter for [Call SDK](../../README.md) — built on Telnyx's **Call Control v2** API: asynchronous REST commands (`answer`, `speak`, `transfer`, `hangup`, ...) paired with webhook events, not TeXML. It normalizes Telnyx's media WebSocket audio to and from the SDK's canonical PCM16/16kHz format and emits call lifecycle events. Like the Twilio adapter, this contains no VAD, transcription, or turn logic — see the [root README](../../README.md#how-it-works) for why that split matters.

Not yet published — see the [root README's Status section](../../README.md#status) for workspace usage. Once published:

```bash
pnpm add @call-adapter/telnyx
```

## Usage

```ts
import { Call } from "call-sdk";
import { createTelnyxAdapter } from "@call-adapter/telnyx";

const call = new Call({
  adapters: {
    telnyx: createTelnyxAdapter({
      // All fields are optional and resolved lazily; see the config table below.
      apiKey: process.env.TELNYX_API_KEY,
      publicKey: process.env.TELNYX_PUBLIC_KEY,
      connectionId: process.env.TELNYX_CONNECTION_ID,
      phoneNumber: process.env.TELNYX_PHONE_NUMBER,
    }),
  },
});

call.onIncomingCall((incoming) => incoming.stream());

// Control plane (any HTTP host):
//   POST /telnyx/voice -> call.webhooks.telnyx(request)
// Media plane (any WebSocket host, held open for the call's duration):
//   upgrade /telnyx/media -> call.media.telnyx(socket)
```

Mounting on a plain `node:http` + `ws` server — the two routes above translate to:

```ts
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/telnyx/voice") {
    // adapt `req` to a WHATWG Request, call call.webhooks.telnyx(request),
    // write the Response back — see examples/twilio-on-ws/src/app.ts for the
    // equivalent node:http <-> Request/Response glue.
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/telnyx/media") {
    wss.handleUpgrade(req, socket, head, (ws) => call.media.telnyx(ws));
  }
});
```

## Config (`TelnyxAdapterConfig`)

Every field is optional; resolution is lazy — nothing throws at construction, only when a value is actually needed (validating a webhook signature, issuing a Call Control command, placing an outbound call). The adapter type-checks and wires into `Call` with zero Telnyx credentials in the environment.

| Field | Default | Notes |
| --- | --- | --- |
| `apiKey` | `process.env.TELNYX_API_KEY` | Bearer token for every Call Control REST command and for `dial`. |
| `publicKey` | `process.env.TELNYX_PUBLIC_KEY` | Base64-encoded Ed25519 public key used to verify `telnyx-signature-ed25519`. |
| `connectionId` | `process.env.TELNYX_CONNECTION_ID` | The Call Control Application outbound calls are placed through. Required by `dial`. |
| `phoneNumber` | `process.env.TELNYX_PHONE_NUMBER` | Default `from` number for `dial`. |
| `mediaPath` | `"/telnyx/media"` | Path the media WebSocket is mounted on. |
| `mediaUrl` | derived from the webhook's `Host` header | The `wss://` URL Telnyx streams media to. Inbound calls can derive it; outbound calls have no inbound request to derive it from, so it's **required** for `dial`. |
| `apiBaseUrl` | `"https://api.telnyx.com"` | Overridable for tests (point at a fake local server). |
| `validateSignature` | `true` iff a public key is configured | Whether inbound webhooks validate `telnyx-signature-ed25519`. |

## The adapter's three duties

Like every `Adapter`, this one does exactly three things — nothing more:

1. **Emit call lifecycle events.** The webhook and media handlers turn Telnyx's `call.initiated`/`call.answered`/`call.hangup` webhook events and the media socket's `start`/`stop`/close into `call-started`/`call-answered`/`call-ended`.
2. **Execute call-control instructions.** The webhook calls `ctx.routeIncomingCall(init)`, then translates the returned `RoutingDecision` into Call Control REST commands (`answer`, `speak`, `transfer`, `hangup`, ...) — pure translation; the adapter never decides a call's fate.
3. **Move normalized audio bidirectionally** over the media WebSocket, plus the outbound `clear()`/`mark()` operations that make barge-in and precise playback-completion detection work.

No VAD, transcription, or turn detection lives here — those are pipeline stages, always above the adapter.

## Call Control v2 vs. TeXML

Telnyx's Call Control is fundamentally asynchronous: instead of returning a markup document synchronously from the webhook (as Twilio's TwiML does), the webhook handler acknowledges the triggering event and then issues one or more REST commands against `/v2/calls/{call_control_id}/actions/{command}`; Telnyx reports each command's outcome via a follow-up webhook event. `src/commands.ts`'s `TelnyxCommandClient` is the REST layer this async command flow is built on.

## Webhook signature verification

Telnyx signs webhooks with Ed25519, not HMAC: the `telnyx-signature-ed25519` header (base64) signs `${timestamp}|${rawBody}`, where `timestamp` is the `telnyx-timestamp` header (unix seconds) and `rawBody` is the exact request body bytes. `src/signature.ts`'s `verifyTelnyxSignature` wraps the base64-distributed raw 32-byte public key in a minimal SPKI DER envelope (`telnyxPublicKeyObject`) and verifies with `node:crypto` only — no external dependency. It never throws: a malformed key/signature, or a stale timestamp outside the tolerance window, simply verifies as `false`.

## Media protocol and audio normalization

`src/protocol.ts` owns the Telnyx media WebSocket wire protocol for one connection: `connected`/`start` bring the session up (`start.call_control_id` and `start.media_format` identify the call and its codec; `start.client_state`/`from`/`to` ride along when present), `media` frames flow bidirectionally, `mark` echoes drive playback-completion detection, and `stop`/socket-close/error all end the call exactly once. Unlike Twilio's Media Streams, Telnyx's outbound frames carry no stream id — the socket connection itself is the addressing, so `serializeTelnyxMedia`/`serializeTelnyxMark`/`serializeTelnyxClear` omit one entirely. A dropped media socket ends the call in v1 (no mid-call reconnection); adapter operations after call end (`write`/`clear`) are safe no-ops.

## Outbound calls

`dial({ adapter: "telnyx", to })` (via `Call.dial`) places an outbound call through Telnyx's Call Control REST API (`POST /v2/calls`) and connects it to the same media plane as an inbound call — `config.mediaUrl` and `config.connectionId` are required since there's no inbound request to derive them from.

## Also exported

For advanced use (custom media hosts, tests): `parseTelnyxMessage`, `createTelnyxCommandClient`, `telnyxPublicKeyObject`/`verifyTelnyxSignature`, and the `TelnyxInboundMessage`/`TelnyxStartMessage`/`TelnyxMediaMessage`/`TelnyxMarkMessage`/`TelnyxStopMessage`/`TelnyxConnectedMessage` protocol types.

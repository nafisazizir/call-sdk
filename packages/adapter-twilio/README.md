# @call-adapter/twilio

Twilio telephony adapter for [Call SDK](../../README.md) — normalizes Twilio's raw Media Streams audio to and from the SDK's canonical PCM16/16kHz format and emits call lifecycle events. Built on Twilio's raw audio streaming layer, not its managed voice-AI product: this adapter contains no VAD, transcription, or turn logic — see the [root README](../../README.md#how-it-works) for why that split matters.

Not yet published — see the [root README's Status section](../../README.md#status) for workspace usage. Once published:

```bash
pnpm add @call-adapter/twilio
```

## Usage

```ts
import { createTwilioAdapter } from "@call-adapter/twilio";
import { Call } from "call-sdk";

const call = new Call({
  adapters: {
    twilio: createTwilioAdapter({
      // All fields are optional and resolved lazily; see the config table below.
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      authToken: process.env.TWILIO_AUTH_TOKEN,
      phoneNumber: process.env.TWILIO_PHONE_NUMBER,
    }),
  },
  onEndOfTurn: async (turn, session) => {
    await session.say("Got it — one moment.");
  },
});

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

See [`examples/twilio-on-ws`](../../examples/twilio-on-ws) for the complete, runnable wiring (including the `node:http` ↔ WHATWG `Request`/`Response` adapter glue).

## Config (`TwilioAdapterConfig`)

Every field is optional; resolution is lazy — nothing throws at construction, only when a value is actually needed (validating a signature, placing an outbound call). The adapter type-checks and wires into `Call` with zero Twilio credentials in the environment.

| Field | Default | Notes |
| --- | --- | --- |
| `accountSid` | `process.env.TWILIO_ACCOUNT_SID` | Required by `startCall`. |
| `authToken` | `process.env.TWILIO_AUTH_TOKEN` | Required for signature validation and `startCall`. |
| `phoneNumber` | `process.env.TWILIO_PHONE_NUMBER` | Default `from` number for `startCall`. |
| `mediaPath` | `"/twilio/media"` | Path the media WebSocket is mounted on. |
| `mediaUrl` | derived from the webhook's `Host` header | The `wss://` URL Twilio dials for media. Inbound calls can derive it; outbound calls have no inbound request to derive it from, so it's **required** for `startCall`. |
| `apiBaseUrl` | `"https://api.twilio.com"` | Overridable for tests (point at a fake local server). |
| `validateSignature` | `true` iff an auth token is configured | Whether inbound webhooks validate `X-Twilio-Signature`. |

## What it does (and doesn't)

The adapter validates `X-Twilio-Signature`, translates the Media Streams JSON protocol (`connected`/`start`/`media`/`mark`/`stop`), and normalizes audio (μ-law/8kHz ⇄ PCM16/16kHz via `mulawDecode`/`mulawEncode` + `upsampleX2`/`downsampleX2` from `call-sdk`). It also implements the outbound `clear()`/`mark()` operations that make barge-in and precise playback-completion detection work. It does not run VAD, transcription, or turn detection — those are pipeline stages, always above the adapter.

A dropped media socket ends the call in v1 (no mid-call reconnection). Adapter operations after call end (`write`/`clear`) are safe no-ops.

Also exported for advanced use (custom media hosts, tests): `parseTwilioMessage`, `connectStreamTwiml`, `startTwilioCall`, `computeTwilioSignature`/`validateTwilioSignature`.

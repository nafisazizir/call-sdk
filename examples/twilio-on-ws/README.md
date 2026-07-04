# example-twilio-on-ws

A minimal voice agent on Twilio, built on `call-sdk`: real caller audio in, an LLM-driven reply spoken back out, over a raw WebSocket media stream — no managed voice-AI product, no framework, just a plain `node:http` server and `ws`.

The whole wiring is small enough to read in one sitting:

```ts
const call = new Call({
  adapters: {
    twilio: createTwilioAdapter({ mediaPath: "/twilio/media" }),
  },
  stages: [createDeepgramStage(), createElevenLabsStage()],
  onCallStarted: (session) => {
    void session.say("Hi! How can I help you today?");
  },
  onEndOfTurn: async (_turn, session) => {
    const { textStream } = streamText({
      model: anthropic("claude-opus-4-8"),
      system: SYSTEM_PROMPT,
      messages: toModelMessages(session.transcript),
    });
    await session.say(textStream);
  },
});
```

Mount `call.webhooks.twilio` on your HTTP route and `call.media.twilio` on your WebSocket route (see [`src/app.ts`](src/app.ts) for the ~30 lines of `node:http` + `ws` glue) and you have a working phone agent. `call-sdk` supplies the VAD and turn-detection stages by default; Deepgram (STT), ElevenLabs (TTS), and the AI SDK (LLM) are swappable at the edges — see [`src/agent.ts`](src/agent.ts) for the LLM call.

## Environment variables

| Variable                | Required            | Purpose                                                                             |
| ------------------------ | -------------------- | ------------------------------------------------------------------------------------ |
| `TWILIO_ACCOUNT_SID`     | for outbound calls   | Twilio account SID, used by `startCall`'s REST call.                                |
| `TWILIO_AUTH_TOKEN`      | yes                  | Validates `X-Twilio-Signature` on inbound webhooks and authenticates outbound calls. |
| `TWILIO_PHONE_NUMBER`    | for outbound calls   | Default `from` number for `pnpm start-call`.                                        |
| `DEEPGRAM_API_KEY`       | yes                  | Streaming speech-to-text.                                                           |
| `ELEVENLABS_API_KEY`     | yes                  | Speech synthesis.                                                                   |
| `ELEVENLABS_VOICE_ID`    | yes                  | Which ElevenLabs voice to speak with.                                               |
| `ANTHROPIC_API_KEY`      | yes                  | The agent's LLM ([`src/agent.ts`](src/agent.ts), Claude via the AI SDK).            |
| `CALL_PUBLIC_URL`        | outbound only\*      | This server's public `https://` URL, e.g. an ngrok tunnel.                          |
| `PORT`                   | no (default `3000`)  | Local port the HTTP + WebSocket server listens on.                                  |

\* For **inbound** calls, the media WebSocket URL is derived from the webhook request's `Host` header, so `CALL_PUBLIC_URL` is optional. For **outbound** calls there is no inbound request to derive it from, so it's required.

## Running a real inbound call

```bash
pnpm dev                              # starts the server on :3000
ngrok http 3000                       # in another terminal
```

Then, in the Twilio console, set the phone number's **"A call comes in"** webhook to `https://<your-ngrok-subdomain>.ngrok-free.app/twilio/voice` (HTTP POST), and call the number. Twilio POSTs the webhook, gets back `<Connect><Stream>` TwiML pointing at `wss://<host>/twilio/media` (derived from the webhook's `Host` header — no `CALL_PUBLIC_URL` needed here), dials that WebSocket, and audio starts flowing both ways.

## Placing an outbound call

```bash
CALL_PUBLIC_URL=https://<your-ngrok-subdomain>.ngrok-free.app pnpm start-call +614xxxxxxxx
```

This starts the server, places the call via Twilio's REST API, waits for the media stream to connect, and exits once the call ends. `CALL_PUBLIC_URL` is required here — see the env var table above.

## Swapping pieces

- **LLM**: any [AI SDK](https://ai-sdk.dev) provider drops into [`src/agent.ts`](src/agent.ts) in place of `anthropic(...)` — the only contract is producing a `string | AsyncIterable<string>` for `session.say()`.
- **STT / TTS / VAD / turn detection**: all pipeline stages are swappable via `createCallServer`'s `stages` option ([`src/app.ts`](src/app.ts)) — swap `createDeepgramStage()` / `createElevenLabsStage()` for other providers, or layer in your own VAD/turn-detection stage, without touching the rest of the wiring.
- **Agent logic**: pass a different `agent` function to `createCallServer` to change what happens on every caller turn, independent of the transport.

## The E2E test

[`src/e2e.test.ts`](src/e2e.test.ts) drives this example's real `createCallServer` wiring end-to-end through `FakeTwilioCall`, a protocol-accurate fake Twilio client (from `@call-adapter/tests`) that signs and POSTs the inbound webhook, opens the media WebSocket, and streams paced mu-law audio frames exactly like a real call would. Only the provider edges are mocked (STT/TTS via the test kit's mock stages); VAD, turn detection, interruption handling, and the full Twilio wire protocol are all real. It needs **zero credentials** — no Twilio account, no Deepgram/ElevenLabs/Anthropic keys, no network egress.

It covers:

- **Happy path** — caller speech → transcript → agent reply → mark echo → `agent-speech-end`, across two turns.
- **Barge-in** — caller speech mid-response interrupts playback exactly once and resolves the in-flight `session.say()` as `{ interrupted: true }`.
- **Teardown + telemetry** — exactly one `call-ended` event, `call.sessions` clears, and `session.telemetry.turns` reports a positive `responseLatencyMs`.
- **Signature rejection** — a webhook signed with the wrong auth token gets a `403` and never opens a media session.

Run it with:

```bash
pnpm test
```

On this machine, the mock pipeline's happy-path turn measured `responseLatencyMs ≈ 3ms` / `voiceToVoiceMs ≈ 66ms` — these are mock-STT/mock-TTS numbers (useful for confirming the instrumentation works end-to-end), not a real-provider latency figure; see SPEC.md's "Observability" section for real-world targets (production voice agents typically land 500–1000ms voice-to-voice).

## The media-plane caveat (serverless)

The control plane (`/twilio/voice`) is ordinary request/response HTTP and runs anywhere, including serverless. The media plane (`/twilio/media`) is a WebSocket held open for the entire call — a long-lived, low-latency connection that serverless platforms are a poor structural fit for (duration caps, cold starts, and autoscaling can all stutter or drop audio mid-call). Per SPEC.md's "Transport & Runtime": **prefer a long-running host** (a VPS, container, Railway, Fly, Render, or similar) for the media plane. Running it on serverless anyway is possible and not prevented by the SDK — just make sure it's an informed trade-off, not a default.

## Note on ElevenLabs output format

`@call-adapter/tts-elevenlabs` requests ElevenLabs' `pcm_16000` output format (matching the SDK's canonical audio format with no resampling needed). Confirm `pcm_16000` is available on your ElevenLabs account tier before relying on it in production — some lower tiers restrict PCM output formats.

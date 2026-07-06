# example-twilio-on-ws

A minimal voice agent on Twilio, built on `call-sdk`: real caller audio in, an LLM-driven reply spoken back out, over a raw WebSocket media stream — no managed voice-AI product, no framework, just a plain `node:http` server and `ws`.

The whole wiring is small enough to read in one sitting:

```ts
const call = new Call({
  adapters: {
    twilio: createTwilioAdapter({ mediaPath: "/twilio/media" }),
  },
});

// Behavior is registered with methods after construction.
call.onIncomingCall((incoming) => incoming.stream());
call.onCallStarted((session) => {
  // Attached synchronously so no buffered inbound audio is missed while the
  // stage graph attaches in the background.
  const voice = attachVoice(session, {
    stages: [createDeepgramStage(), createElevenLabsStage()],
    onEndOfTurn: async (_turn, voice) => {
      const { textStream } = streamText({
        model: "openai/gpt-5-nano", // via the Vercel AI Gateway
        system: SYSTEM_PROMPT,
        messages: toModelMessages(voice.transcript),
      });
      await voice.say(textStream);
    },
  });
  void voice.say("Hi! How can I help you today?");
});
```

Mount `call.webhooks.twilio` on your HTTP route and `call.media.twilio` on your WebSocket route (see [`src/app.ts`](src/app.ts) for the ~30 lines of `node:http` + `ws` glue) and you have a working phone agent. `@call-adapter/pipeline`'s `attachVoice` supplies the VAD and turn-detection stages by default; Deepgram (STT), ElevenLabs (TTS), and the LLM (GPT-5 nano via the AI SDK + Vercel AI Gateway) are swappable at the edges — see [`src/agent.ts`](src/agent.ts) for the LLM call.

## Environment variables

| Variable                | Required            | Purpose                                                                             |
| ------------------------ | -------------------- | ------------------------------------------------------------------------------------ |
| `TWILIO_ACCOUNT_SID`     | for outbound calls   | Twilio account SID, used by `startCall`'s REST call.                                |
| `TWILIO_AUTH_TOKEN`      | yes                  | Validates `X-Twilio-Signature` on inbound webhooks and authenticates outbound calls. |
| `TWILIO_PHONE_NUMBER`    | for outbound calls   | Default `from` number for `pnpm start-call`.                                        |
| `DEEPGRAM_API_KEY`       | yes                  | Streaming speech-to-text.                                                           |
| `ELEVENLABS_API_KEY`     | yes                  | Speech synthesis.                                                                   |
| `ELEVENLABS_VOICE_ID`    | yes                  | Which ElevenLabs voice to speak with.                                               |
| `AI_GATEWAY_API_KEY`     | yes\*\*              | The agent's LLM ([`src/agent.ts`](src/agent.ts), GPT-5 nano via the AI SDK + Vercel AI Gateway). |
| `CALL_PUBLIC_URL`        | outbound only\*      | This server's public `https://` URL, e.g. an ngrok tunnel.                          |
| `PORT`                   | no (default `3000`)  | Local port the HTTP + WebSocket server listens on.                                  |

\* For **inbound** calls, the media WebSocket URL is derived from the webhook request's `Host` header, so `CALL_PUBLIC_URL` is optional. For **outbound** calls there is no inbound request to derive it from, so it's required.

\*\* `AI_GATEWAY_API_KEY` is needed for local runs. When deployed on Vercel, the AI Gateway authenticates via OIDC automatically, so it's optional there.

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

- **LLM**: swap the `"openai/gpt-5-nano"` model string in [`src/agent.ts`](src/agent.ts) for any other [AI Gateway](https://vercel.com/docs/ai-gateway) model, or drop in an explicit [AI SDK](https://ai-sdk.dev) provider — the only contract is producing a `string | AsyncIterable<string>` for `voice.say()`.
- **STT / TTS / VAD / turn detection**: all pipeline stages are swappable via `createCallServer`'s `stages` option ([`src/app.ts`](src/app.ts)) — swap `createDeepgramStage()` / `createElevenLabsStage()` for other providers, or layer in your own VAD/turn-detection stage, without touching the rest of the wiring.
- **Agent logic**: pass a different `agent` function to `createCallServer` to change what happens on every caller turn, independent of the transport.

## Handling noisy environments

If the caller is somewhere loud (a kitchen, a crowd, friends talking nearby), background sound can trip the agent into thinking it was interrupted and cut its own turn short. Two layers guard against this, both tunable via `createCallServer`:

1. **VAD sensitivity** — how loud, and for how long, audio must register before it counts as speech at all. The default here is deliberately less twitchy than the SDK's built-in VAD: `createEnergyVadStage({ thresholdDb: 16, activationFrames: 5 })` (louder-relative-to-room, and ~100ms of sustained voice). Raise `thresholdDb` / `activationFrames` to reject more; lower them if the caller's real speech is being missed.
2. **Barge-in gate** — `interruption.minSpeechMs` (default **500**): how long sustained speech must continue *while the agent is talking* before it actually interrupts. A dish clatter or a brief word ends before the timer fires and is ignored. Raise it to reject more background noise (at the cost of barge-in feeling less snappy); set `0` for instant, twitchy interruption.

```ts
createCallServer({
  interruption: { minSpeechMs: 700 }, // even more tolerant of background noise
  stages: [
    createEnergyVadStage({ thresholdDb: 18, activationFrames: 6 }),
    createDeepgramStage(),
    createElevenLabsStage(),
  ],
});
```

**The hard limit:** the built-in VAD is an *energy gate* — it detects that there is voice energy, not *whose* voice it is. It can robustly filter transient or low-level noise, but it cannot tell a bystander's sustained speech from the caller's; both are real speech. If background *conversation* is your problem, you need a different tool: a neural VAD stage (better speech-vs-noise discrimination), gating barge-in on the actual transcript rather than raw energy, or speaker identification so only the enrolled caller's voice counts. All three slot in as swappable stages without touching the rest of the wiring.

## The E2E test

[`src/e2e.test.ts`](src/e2e.test.ts) drives this example's real `createCallServer` wiring end-to-end through `FakeTwilioCall`, a protocol-accurate fake Twilio client (from `@call-adapter/tests`) that signs and POSTs the inbound webhook, opens the media WebSocket, and streams paced mu-law audio frames exactly like a real call would. Only the provider edges are mocked (STT/TTS via the test kit's mock stages); VAD, turn detection, interruption handling, and the full Twilio wire protocol are all real. It needs **zero credentials** — no Twilio account, no Deepgram/ElevenLabs/AI Gateway keys, no network egress.

It covers:

- **Happy path** — caller speech → transcript → agent reply → mark echo → `agent-speech-end`, across two turns.
- **Barge-in** — caller speech mid-response interrupts playback exactly once and resolves the in-flight `voice.say()` as `{ interrupted: true }`.
- **Teardown + telemetry** — exactly one `call-ended` event, `call.sessions` clears, and `voice.turns` reports a positive `responseLatencyMs`.
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

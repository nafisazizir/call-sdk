# @call-adapter/stt-deepgram

Streaming transcription stage for [Call SDK](../../README.md) backed by Deepgram — consumes normalized audio and emits interim and final transcript events, and can feed Deepgram's endpointing signal into turn detection.

Speaks the Deepgram Listen websocket protocol directly over the platform's global `WebSocket` (Node >=22) — no `@deepgram/sdk` dependency at runtime. Authenticates via the WebSocket subprotocol handshake (`new WebSocket(url, ["token", apiKey])`).

Not yet published — see the [root README's Status section](../../README.md#status) for workspace usage. Once published:

```bash
pnpm add @call-adapter/stt-deepgram
```

## Usage

```ts
import { createDeepgramStage } from "@call-adapter/stt-deepgram";
import { Call } from "call-sdk";

const call = new Call({
  adapters: { /* ... */ },
  stages: [
    createDeepgramStage({
      // apiKey defaults to process.env.DEEPGRAM_API_KEY, read lazily at attach()
      model: "nova-3",
      language: "en",
    }),
    // a TTS stage, e.g. @call-adapter/tts-elevenlabs
  ],
});
```

## Config (`DeepgramStageConfig`)

| Field | Default | Notes |
| --- | --- | --- |
| `apiKey` | `process.env.DEEPGRAM_API_KEY` | Read lazily at `attach()` — the stage type-checks and constructs with no key set. |
| `model` | `"nova-3"` | Deepgram model. |
| `language` | `"en"` | Transcription language. |
| `smartFormat` | `true` | Deepgram's `smart_format` post-processing. |
| `endpointingMs` | `300` | Endpointing sensitivity (ms of silence), sent as `&endpointing=`. |
| `utteranceEndMs` | `1000` | `UtteranceEnd` delay (ms), sent as `&utterance_end_ms=`. |
| `baseUrl` | `"wss://api.deepgram.com/v1/listen"` | Overridable for tests (point at a fake local server). |

## Events

- **Consumes:** `audio-frame`.
- **Emits:** `transcript-interim` (in-progress text as the caller speaks), `transcript-final` (a finalized segment, with `confidence`/`startMs`/`endMs`), `stt-endpoint` (Deepgram's own endpointing signal — Deepgram sends this on `speech_final` results and on `UtteranceEnd` messages). A turn-detection stage may optionally consume `stt-endpoint` to detect end-of-turn faster than a pure silence timer.

## Failure model

v1 does no automatic recovery: a socket drop (or connection failure) before the stage begins its own graceful shutdown surfaces as a fatal session `error`, ending the call. Audio arriving before the socket opens is buffered (up to ~2s) and flushed on connect, so a slow handshake doesn't lose the caller's first words.

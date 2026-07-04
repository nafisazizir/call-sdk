# @call-adapter/tts-elevenlabs

Speech synthesis stage for [Call SDK](../../README.md) backed by ElevenLabs — consumes response text (`agent-say`) and produces streamed canonical PCM16/16kHz audio for the adapter to play back.

Speaks ElevenLabs' HTTP streaming endpoint (`POST /v1/text-to-speech/{voiceId}/stream`) per text chunk, not the WebSocket input-streaming API, and requests the `pcm_16000` output format — the SDK's canonical sample rate, so no resampling happens downstream.

Not yet published — see the [root README's Status section](../../README.md#status) for workspace usage. Once published:

```bash
pnpm add @call-adapter/tts-elevenlabs
```

## Usage

```ts
import { createElevenLabsStage } from "@call-adapter/tts-elevenlabs";
import { Call } from "call-sdk";

const call = new Call({
  adapters: { /* ... */ },
  stages: [
    // an STT stage, e.g. @call-adapter/stt-deepgram
    createElevenLabsStage({
      // apiKey/voiceId default to process.env.ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID,
      // read lazily at attach()
      modelId: "eleven_turbo_v2_5",
    }),
  ],
});
```

## Config (`ElevenLabsStageConfig`)

| Field | Default | Notes |
| --- | --- | --- |
| `apiKey` | `process.env.ELEVENLABS_API_KEY` | Read lazily at `attach()` — the stage type-checks and constructs with no key set. |
| `voiceId` | `process.env.ELEVENLABS_VOICE_ID` | Which ElevenLabs voice to speak with. |
| `modelId` | `"eleven_turbo_v2_5"` | ElevenLabs model. |
| `optimizeStreamingLatency` | `3` | ElevenLabs' `optimize_streaming_latency` query param (0-4). |
| `outputFormat` | `"pcm_16000"` | Only value supported — expressed as a one-member union so widening to other rates later is additive. |
| `baseUrl` | `"https://api.elevenlabs.io"` | Overridable for tests (point at a fake local server). |

## Events

- **Consumes:** `agent-say` (the sole command event — `{ utteranceId, text: string \| AsyncIterable<string>, signal }`).
- **Emits:** `audio-out` (per canonical audio frame), `agent-generation-end` (fact: no further `audio-out` will follow for this utterance — core uses it to arm playback-completion detection).

## Abort semantics

Each call's own `AbortSignal` (from `agent-say`), the session's teardown signal, and an internal "superseded by a newer `agent-say`" signal are combined via `AbortSignal.any`. Aborting cancels the in-flight fetch and stream read; the stage never publishes stray `audio-out` frames for an utterance that's already been superseded or interrupted.

## `pcm_16000` tier note

Confirm `pcm_16000` output is available on your ElevenLabs account tier before relying on it in production — some lower tiers restrict PCM output formats to a subset.

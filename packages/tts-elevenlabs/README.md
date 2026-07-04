# @call-adapter/tts-elevenlabs

Speech synthesis stage for Call SDK backed by ElevenLabs — consumes response text and produces streamed audio for the adapter to play back.

Speaks ElevenLabs' HTTP streaming endpoint (`POST /v1/text-to-speech/{voiceId}/stream`), not the WebSocket input-streaming API, and requests the canonical `pcm_16000` output format so no resampling is needed downstream.

```ts
import { createElevenLabsStage } from "@call-adapter/tts-elevenlabs";

const elevenlabs = createElevenLabsStage({
  // apiKey/voiceId default to process.env.ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID,
  // read lazily at attach()
  modelId: "eleven_turbo_v2_5",
});
```

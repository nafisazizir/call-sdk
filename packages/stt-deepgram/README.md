# @call-adapter/stt-deepgram

Streaming transcription stage for Call SDK backed by Deepgram — consumes normalized audio and emits interim and final transcript events, and can feed Deepgram's endpointing signal into turn detection.

Speaks the Deepgram Listen websocket protocol directly over the platform's global `WebSocket` (Node >=22) — no `@deepgram/sdk` dependency at runtime. Authenticates via the WebSocket subprotocol handshake (`new WebSocket(url, ["token", apiKey])`).

```ts
import { createDeepgramStage } from "@call-adapter/stt-deepgram";

const deepgram = createDeepgramStage({
  // apiKey defaults to process.env.DEEPGRAM_API_KEY, read lazily at attach()
  model: "nova-3",
  language: "en",
});
```

Per SPEC.md's failure model, v1 does no automatic recovery: a socket drop before the stage begins its own graceful shutdown surfaces as a fatal session `error`.

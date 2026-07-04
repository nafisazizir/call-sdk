---
"call-sdk": minor
"@call-adapter/twilio": minor
"@call-adapter/stt-deepgram": minor
"@call-adapter/tts-elevenlabs": minor
"@call-adapter/tests": minor
---

Initial release: a unified toolkit for building real-time AI voice agents across any telephony or voice provider. `call-sdk` provides `Call`/`CallSession`, a typed event bus, the default VAD/turn-detection pipeline, and canonical audio primitives; `@call-adapter/twilio` is the v1 reference telephony adapter (raw Media Streams); `@call-adapter/stt-deepgram` and `@call-adapter/tts-elevenlabs` are the reference STT/TTS pipeline stages; `@call-adapter/tests` is the shared conformance suite and mock kit for adapter/stage authors.

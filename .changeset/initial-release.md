---
"call-sdk": minor
"@call-adapter/twilio": minor
"@call-adapter/tests": minor
---

Initial release: a provider-agnostic SDK for telephony and real-time voice. `call-sdk` provides `Call`/`CallSession`, the call-control verb set, a typed event bus, and canonical audio primitives; `@call-adapter/twilio` is the v1 reference telephony adapter (raw Media Streams); `@call-adapter/tests` is the shared conformance suite and mock kit for adapter authors. The optional voice pipeline (VAD, turn detection, STT/TTS stages) is demonstrated in `examples/twilio-on-ws`.

---
"@call-adapter/telnyx": minor
"@call-adapter/tests": minor
---

Add the Telnyx adapter (`@call-adapter/telnyx`) — the second provider, built on Telnyx Call Control v2's async command model. Inbound routing verbs translate to REST commands sequenced via `client_state` (stateless, serverless-safe); the media plane speaks Telnyx's bidirectional streaming protocol in L16 @ 16 kHz rtp mode with a PCMU fallback; webhooks are verified with Ed25519. `@call-adapter/tests` gains a protocol-accurate fake Telnyx (`startFakeTelnyxCall`, `startFakeTelnyxApi`, `createFakeTelnyxKeys`) mirroring the fake Twilio client.

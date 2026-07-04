# @call-adapter/twilio

Twilio telephony adapter for Call SDK — normalizes Twilio's raw Media Streams audio to and from the SDK's canonical format and emits call lifecycle events. Built on Twilio's raw audio streaming layer, not its managed voice-AI product (see [SPEC.md](../../SPEC.md#design-decisions--rationale)).

```ts
import { createTwilioAdapter } from "@call-adapter/twilio";
import { Call } from "call-sdk";

const call = new Call({
  adapters: {
    twilio: createTwilioAdapter({
      // All fields are optional and resolved lazily; see TwilioAdapterConfig.
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

The adapter is thin by design (SPEC.md, The Adapter Contract): it validates `X-Twilio-Signature`, translates the Media Streams JSON protocol, and normalizes audio (μ-law/8kHz ⇄ PCM16/16kHz) — no VAD, transcription, or turn logic lives here.

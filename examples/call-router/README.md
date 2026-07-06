# example-call-router

Pure call-control routing with `call-sdk`: no WebSocket, no media plane, no AI. This is the headline "route calls in a few lines" use case — every inbound call is decided entirely at the control-plane webhook.

The whole routing decision is small enough to read in one sitting:

```ts
const call = new Call({ adapters: { twilio: createTwilioAdapter(...) } });

call.onIncomingCall((incoming) => {
  if (BLOCKLIST.has(incoming.from ?? "")) {
    return incoming.reject();
  }
  if (isAfterHours(new Date())) {
    return incoming.forwardTo(ON_CALL_NUMBER);
  }
  return incoming.voicemail({ prompt: "We're unavailable — leave a message." });
});
```

No call here ever calls `incoming.stream()`, so no `CallSession` is ever created and no media plane is needed — just `call.webhooks.twilio` mounted on one HTTP route (see [`src/app.ts`](src/app.ts)).

## The three routing branches

1. **Blocklist** — a caller in `CALL_ROUTER_BLOCKLIST` is rejected outright (`<Reject>`), never answered.
2. **After hours** — outside business hours, the call is forwarded (`<Dial><Number>`) to `CALL_ROUTER_ON_CALL_NUMBER`.
3. **Business hours** — the default: a prompt is played and a message is recorded (`<Say>` + `<Record>`), then the call hangs up.

## Environment variables

| Variable                            | Default          | Purpose                                                |
| ------------------------------------ | ---------------- | ------------------------------------------------------- |
| `TWILIO_AUTH_TOKEN`                  | —                 | Validates `X-Twilio-Signature` on inbound webhooks.     |
| `CALL_ROUTER_BLOCKLIST`              | (empty)           | Comma-separated E.164 numbers to reject outright.       |
| `CALL_ROUTER_ON_CALL_NUMBER`         | `+15550001234`    | Number after-hours calls are forwarded to.              |
| `CALL_ROUTER_BUSINESS_HOURS_START`   | `9`               | Hour (0-23, local server time) business hours start.    |
| `CALL_ROUTER_BUSINESS_HOURS_END`     | `18`              | Hour (0-23, local server time) business hours end.      |
| `PORT`                               | `3000`            | Local port the HTTP server listens on.                  |

## Running it

```bash
pnpm dev                        # starts the server on :3000
ngrok http 3000                 # in another terminal
```

Set the phone number's **"A call comes in"** webhook (in the Twilio console) to `https://<your-ngrok-subdomain>.ngrok-free.app/twilio/voice` (HTTP POST), and call the number.

## Swapping providers

The one line that's provider-specific is the adapter itself:

```ts
adapters: { twilio: createTwilioAdapter(...) }
```

Everything else — `onIncomingCall` and its routing decisions (`reject`, `forwardTo`, `voicemail`, ...) — is written against `call-sdk`'s provider-agnostic `IncomingCall` surface. Swap in a different adapter and the routing logic is unchanged.

## The E2E test

[`src/e2e.test.ts`](src/e2e.test.ts) drives this example's real `createRouterServer` wiring end-to-end through `FakeTwilioCall` (from `@call-adapter/tests`) — no real Twilio account, no network egress. `isAfterHours` and the blocklist are injectable through `createRouterServer`'s options, so each branch is forced deterministically without faking the system clock. It covers:

- **Blocklist** — a blocked caller gets `<Reject>`, `connected === false`, and no session is created.
- **After hours** — the call is forwarded with `<Dial><Number>` to the on-call number.
- **Business hours** — `<Say>` then `<Record>`, followed by the `<Record action>` continuation hit (signed, like Twilio would send it) resolving to `<Hangup/>`.
- **Signature rejection** — a webhook signed with the wrong auth token gets a `403`.

Run it with:

```bash
pnpm test
```

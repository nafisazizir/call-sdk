/**
 * Zero-credential end-to-end test for this example: the real
 * `createRouterServer` wiring (`src/app.ts`), driven entirely through
 * `FakeTwilioCall` — a protocol-accurate fake Twilio client from
 * `@call-adapter/tests`. No real Twilio account, no media plane (this
 * example never calls `incoming.stream()`), no network egress at all.
 *
 * Covers all three routing branches (blocklist, after-hours forward,
 * business-hours voicemail) plus the `<Record>` continuation and signature
 * rejection — mirroring the style of
 * `examples/twilio-on-ws/src/e2e.test.ts`.
 */

import {
  computeFakeTwilioSignature,
  parseTwiml,
  startFakeTwilioCall,
} from "@call-adapter/tests";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CallRouterServerOptions,
  createRouterServer,
  VOICEMAIL_PROMPT,
  WEBHOOK_PATH,
} from "./app.js";

const AUTH_TOKEN = "test-auth-token";
const BLOCKED_NUMBER = "+15559990000";
const ON_CALL_NUMBER = "+15551230000";

describe("examples/call-router E2E (zero credentials)", () => {
  let baseUrl: string;
  let close: () => Promise<void>;

  async function start(options: CallRouterServerOptions = {}) {
    const server = createRouterServer({
      twilio: { authToken: AUTH_TOKEN, validateSignature: true },
      onCallNumber: ON_CALL_NUMBER,
      // "error" keeps CI logs clean while still surfacing anything
      // unexpected — the invalid-signature test below intentionally
      // triggers a "warn", which this suppresses.
      logger: "error",
      ...options,
    });
    const listening = await server.listen(0);
    baseUrl = `http://127.0.0.1:${listening.port}`;
    close = listening.close;
    return server;
  }

  afterEach(async () => {
    await close();
  });

  it("rejects a blocked caller: <Reject>, connected === false, no session created", async () => {
    const server = await start({
      blocklist: new Set([BLOCKED_NUMBER]),
      isAfterHours: () => false,
    });

    const fake = await startFakeTwilioCall({
      baseUrl,
      webhookPath: WEBHOOK_PATH,
      authToken: AUTH_TOKEN,
      from: BLOCKED_NUMBER,
    });

    expect(fake.connected).toBe(false);
    expect(fake.twimlResponse.status).toBe(200);
    const verbs = parseTwiml(fake.twimlResponse.body);
    expect(verbs).toHaveLength(1);
    expect(verbs[0]?.tag).toBe("Reject");
    expect(server.call.sessions.size).toBe(0);
  });

  it("forwards to the on-call number after hours", async () => {
    const server = await start({
      blocklist: new Set(),
      isAfterHours: () => true,
    });

    const fake = await startFakeTwilioCall({
      baseUrl,
      webhookPath: WEBHOOK_PATH,
      authToken: AUTH_TOKEN,
    });

    expect(fake.connected).toBe(false);
    const verbs = parseTwiml(fake.twimlResponse.body);
    expect(verbs).toHaveLength(1);
    expect(verbs[0]?.tag).toBe("Dial");
    expect(verbs[0]?.children).toHaveLength(1);
    expect(verbs[0]?.children[0]?.tag).toBe("Number");
    expect(verbs[0]?.children[0]?.text).toBe(ON_CALL_NUMBER);
    expect(server.call.sessions.size).toBe(0);
  });

  it("during business hours, not blocked: <Say> then <Record>, and the record continuation hangs up", async () => {
    const server = await start({
      blocklist: new Set(),
      isAfterHours: () => false,
    });

    const fake = await startFakeTwilioCall({
      baseUrl,
      webhookPath: WEBHOOK_PATH,
      authToken: AUTH_TOKEN,
    });

    expect(fake.connected).toBe(false);
    const verbs = parseTwiml(fake.twimlResponse.body);
    expect(verbs).toHaveLength(2);
    expect(verbs[0]?.tag).toBe("Say");
    expect(verbs[0]?.text).toBe(VOICEMAIL_PROMPT);
    expect(verbs[1]?.tag).toBe("Record");
    const actionUrl = verbs[1]?.attributes.action;
    expect(actionUrl).toBeDefined();
    expect(actionUrl).toContain("call_sdk_action=hangup");
    expect(server.call.sessions.size).toBe(0);

    // The <Record action> continuation: Twilio re-requests this URL once
    // recording ends. It's signed the same way any Twilio request is; the
    // adapter recognizes the `call_sdk_action=hangup` query param and
    // short-circuits to <Hangup/> without re-running routing.
    const continuationFields = {
      CallSid: "CAcontinuation00000000000000000000",
      From: "+15550001111",
      To: "+15550002222",
      Direction: "inbound",
      AccountSid: "ACcontinuation0000000000000000000",
    };
    const signature = computeFakeTwilioSignature(
      AUTH_TOKEN,
      actionUrl as string,
      continuationFields
    );
    const response = await fetch(actionUrl as string, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature,
      },
      body: new URLSearchParams(continuationFields).toString(),
    });
    expect(response.status).toBe(200);
    const continuationVerbs = parseTwiml(await response.text());
    expect(continuationVerbs).toHaveLength(1);
    expect(continuationVerbs[0]?.tag).toBe("Hangup");
  });

  it("rejects a webhook with an invalid signature with 403", async () => {
    await start();

    const fake = await startFakeTwilioCall({
      baseUrl,
      webhookPath: WEBHOOK_PATH,
      authToken: "wrong-token",
    });

    expect(fake.twimlResponse.status).toBe(403);
    expect(fake.connected).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  createIncomingCall,
  defaultStreamDecision,
  failureRejectDecision,
  isRoutingDecision,
  ROUTING_DECISION_KIND,
} from "./routing";

const INIT = { callId: "CA123", from: "+15550001111", to: "+15550002222" };

describe("IncomingCall verb methods", () => {
  it("exposes the call facts it was created from", () => {
    const incoming = createIncomingCall("twilio", {
      ...INIT,
      raw: { AccountSid: "AC1" },
    });
    expect(incoming.adapter).toBe("twilio");
    expect(incoming.callId).toBe("CA123");
    expect(incoming.from).toBe("+15550001111");
    expect(incoming.to).toBe("+15550002222");
    expect(incoming.raw).toEqual({ AccountSid: "AC1" });
  });

  it("omits absent facts instead of setting undefined", () => {
    const incoming = createIncomingCall("twilio", { callId: "CA1" });
    expect("from" in incoming).toBe(false);
    expect("to" in incoming).toBe(false);
    expect("raw" in incoming).toBe(false);
  });

  it("reject() defaults to rejected and supports busy", () => {
    const incoming = createIncomingCall("twilio", INIT);
    expect(incoming.reject().actions).toEqual([
      { type: "reject", reason: "rejected" },
    ]);
    expect(incoming.reject({ busy: true }).actions).toEqual([
      { type: "reject", reason: "busy" },
    ]);
  });

  it("forwardTo() carries the number and only the options that were set", () => {
    const incoming = createIncomingCall("twilio", INIT);
    expect(incoming.forwardTo("+15550003333").actions).toEqual([
      { type: "forward", to: "+15550003333" },
    ]);
    expect(
      incoming.forwardTo("+15550003333", {
        callerId: "+15550004444",
        timeoutSeconds: 15,
      }).actions
    ).toEqual([
      {
        type: "forward",
        to: "+15550003333",
        callerId: "+15550004444",
        timeoutSeconds: 15,
      },
    ]);
  });

  it("say() and play() are single standalone actions", () => {
    const incoming = createIncomingCall("twilio", INIT);
    expect(incoming.say("closed today").actions).toEqual([
      { type: "say", text: "closed today" },
    ]);
    expect(
      incoming.say("hola", { voice: "alice", language: "es-MX" }).actions
    ).toEqual([
      { type: "say", text: "hola", voice: "alice", language: "es-MX" },
    ]);
    expect(incoming.play("https://cdn.example/prompt.mp3").actions).toEqual([
      { type: "play", url: "https://cdn.example/prompt.mp3" },
    ]);
  });

  it("voicemail() composes say + record, with defaults", () => {
    const incoming = createIncomingCall("twilio", INIT);
    expect(incoming.voicemail({ prompt: "Leave a message." }).actions).toEqual([
      { type: "say", text: "Leave a message." },
      { type: "record", maxLengthSeconds: 120, playBeep: true },
    ]);
    expect(incoming.voicemail().actions).toEqual([
      { type: "record", maxLengthSeconds: 120, playBeep: true },
    ]);
    expect(incoming.voicemail({ maxLengthSeconds: 30 }).actions).toEqual([
      { type: "record", maxLengthSeconds: 30, playBeep: true },
    ]);
  });

  it("stream() and hangup() are single actions", () => {
    const incoming = createIncomingCall("twilio", INIT);
    expect(incoming.stream().actions).toEqual([{ type: "stream" }]);
    expect(incoming.hangup().actions).toEqual([{ type: "hangup" }]);
  });

  it("every decision carries the brand", () => {
    const incoming = createIncomingCall("twilio", INIT);
    for (const decision of [
      incoming.reject(),
      incoming.forwardTo("+1"),
      incoming.say("x"),
      incoming.play("u"),
      incoming.voicemail(),
      incoming.stream(),
      incoming.hangup(),
    ]) {
      expect(decision.kind).toBe(ROUTING_DECISION_KIND);
      expect(isRoutingDecision(decision)).toBe(true);
    }
  });
});

describe("isRoutingDecision", () => {
  it("rejects non-decisions", () => {
    expect(isRoutingDecision(undefined)).toBe(false);
    expect(isRoutingDecision(null)).toBe(false);
    expect(isRoutingDecision("stream")).toBe(false);
    expect(isRoutingDecision({ actions: [] })).toBe(false);
    expect(isRoutingDecision({ kind: "other", actions: [] })).toBe(false);
    expect(
      isRoutingDecision({ kind: ROUTING_DECISION_KIND, actions: "nope" })
    ).toBe(false);
  });
});

describe("fallback decisions", () => {
  it("defaults to stream when no handler is registered", () => {
    expect(defaultStreamDecision().actions).toEqual([{ type: "stream" }]);
  });

  it("rejects on handler failure", () => {
    expect(failureRejectDecision().actions).toEqual([
      { type: "reject", reason: "rejected" },
    ]);
  });
});

import type { RoutingAction, RoutingDecision } from "call-sdk";
import { describe, expect, it } from "vitest";
import {
  advanceSequence,
  decodeClientState,
  encodeClientState,
  parseTelnyxWebhook,
  planInitialCommand,
  type TelnyxCallState,
  type TelnyxWebhookEvent,
  telnyxCommandId,
} from "./events";

const CCID = "v3:call-control-id-123";

function decision(...actions: RoutingAction[]): RoutingDecision {
  return { kind: "call-sdk/routing-decision", actions };
}

function webhookBody(
  eventType: string,
  payload: Record<string, unknown>
): string {
  return JSON.stringify({ data: { event_type: eventType, payload } });
}

function eventWith(eventType: string, clientState: string): TelnyxWebhookEvent {
  return {
    eventType,
    payload: { callControlId: CCID, clientState, raw: {} },
  };
}

describe("parseTelnyxWebhook", () => {
  it("maps a well-formed webhook's snake_case fields to camelCase", () => {
    const event = parseTelnyxWebhook(
      webhookBody("call.initiated", {
        call_control_id: CCID,
        call_session_id: "sess-1",
        from: "+15551110000",
        to: "+15552220000",
        direction: "incoming",
        state: "parked",
        client_state: "abc",
      })
    );
    expect(event).toBeDefined();
    expect(event?.eventType).toBe("call.initiated");
    expect(event?.payload.callControlId).toBe(CCID);
    expect(event?.payload.callSessionId).toBe("sess-1");
    expect(event?.payload.from).toBe("+15551110000");
    expect(event?.payload.to).toBe("+15552220000");
    expect(event?.payload.direction).toBe("incoming");
    expect(event?.payload.state).toBe("parked");
    expect(event?.payload.clientState).toBe("abc");
  });

  it("keeps the whole payload as `raw`", () => {
    const event = parseTelnyxWebhook(
      webhookBody("call.answered", { call_control_id: CCID, extra: "kept" })
    );
    expect(event?.payload.raw).toMatchObject({
      call_control_id: CCID,
      extra: "kept",
    });
  });

  it("returns undefined on invalid JSON", () => {
    expect(parseTelnyxWebhook("not json")).toBeUndefined();
  });

  it("returns undefined when the shape is wrong", () => {
    expect(parseTelnyxWebhook(JSON.stringify({ data: {} }))).toBeUndefined();
    expect(
      parseTelnyxWebhook(JSON.stringify({ data: { event_type: "x" } }))
    ).toBeUndefined();
    expect(
      parseTelnyxWebhook(
        webhookBody("call.initiated", { from: "+1" }) // no call_control_id
      )
    ).toBeUndefined();
  });
});

describe("client_state codec", () => {
  it("round-trips a state through encode/decode", () => {
    const state: TelnyxCallState = {
      v: 1,
      mode: "sequence",
      direction: "inbound",
      q: [{ type: "say", text: "hi" }, { type: "hangup" }],
      step: 2,
    };
    expect(decodeClientState(encodeClientState(state))).toEqual(state);
  });

  it("returns undefined for undefined/empty input", () => {
    expect(decodeClientState(undefined)).toBeUndefined();
    expect(decodeClientState("")).toBeUndefined();
  });

  it("returns undefined for non-base64 / non-JSON garbage", () => {
    expect(decodeClientState("!!!not base64!!!")).toBeUndefined();
    expect(
      decodeClientState(Buffer.from("not json").toString("base64"))
    ).toBeUndefined();
  });

  it("rejects a foreign client_state (missing/mismatched version)", () => {
    // A client_state the consumer's own tooling might set — valid base64
    // JSON, but not ours. Must NOT be interpreted as a sequence.
    const foreign = Buffer.from(
      JSON.stringify({ some: "other", tooling: true })
    ).toString("base64");
    expect(decodeClientState(foreign)).toBeUndefined();

    const wrongVersion = Buffer.from(
      JSON.stringify({ v: 2, mode: "sequence", q: [], step: 1 })
    ).toString("base64");
    expect(decodeClientState(wrongVersion)).toBeUndefined();
  });

  it("rejects a structurally wrong state", () => {
    const badMode = Buffer.from(
      JSON.stringify({ v: 1, mode: "bogus", q: [], step: 1 })
    ).toString("base64");
    expect(decodeClientState(badMode)).toBeUndefined();

    const badQueue = Buffer.from(
      JSON.stringify({ v: 1, mode: "sequence", q: "nope", step: 1 })
    ).toString("base64");
    expect(decodeClientState(badQueue)).toBeUndefined();

    const badDirection = Buffer.from(
      JSON.stringify({
        v: 1,
        mode: "sequence",
        q: [],
        step: 1,
        direction: "sideways",
      })
    ).toString("base64");
    expect(decodeClientState(badDirection)).toBeUndefined();
  });
});

describe("planInitialCommand", () => {
  const opts = {
    callControlId: CCID,
    direction: "inbound" as const,
    streamUrl: "wss://media.example.com/telnyx/media",
  };

  it("plans a reject (busy -> USER_BUSY) with no answer", () => {
    const { plan } = planInitialCommand(
      decision({ type: "reject", reason: "busy" }),
      opts
    );
    expect(plan).toEqual({ kind: "reject", cause: "USER_BUSY" });
  });

  it("plans a reject (rejected -> CALL_REJECTED)", () => {
    const { plan } = planInitialCommand(
      decision({ type: "reject", reason: "rejected" }),
      opts
    );
    expect(plan).toEqual({ kind: "reject", cause: "CALL_REJECTED" });
  });

  it("plans a hangup with no answer", () => {
    const { plan } = planInitialCommand(decision({ type: "hangup" }), opts);
    expect(plan).toEqual({ kind: "hangup" });
  });

  it("plans an answer carrying stream params for a stream decision", () => {
    const { plan } = planInitialCommand(decision({ type: "stream" }), opts);
    expect(plan.kind).toBe("answer");
    if (plan.kind !== "answer") {
      throw new Error("expected answer");
    }
    expect(plan.stream).toEqual({ streamUrl: opts.streamUrl });
    const state = decodeClientState(plan.clientState);
    expect(state).toMatchObject({
      mode: "stream",
      direction: "inbound",
      q: [],
      step: 1,
    });
  });

  it("plans a say sequence as answer(no stream) with [say, hangup] queued", () => {
    const { plan } = planInitialCommand(
      decision({ type: "say", text: "hello" }),
      opts
    );
    if (plan.kind !== "answer") {
      throw new Error("expected answer");
    }
    expect(plan.stream).toBeUndefined();
    const state = decodeClientState(plan.clientState);
    expect(state?.mode).toBe("sequence");
    expect(state?.q).toEqual([
      { type: "say", text: "hello" },
      { type: "hangup" },
    ]);
  });

  it("plans a play sequence as [play, hangup]", () => {
    const { plan } = planInitialCommand(
      decision({ type: "play", url: "https://x/a.mp3" }),
      opts
    );
    if (plan.kind !== "answer") {
      throw new Error("expected answer");
    }
    expect(decodeClientState(plan.clientState)?.q).toEqual([
      { type: "play", url: "https://x/a.mp3" },
      { type: "hangup" },
    ]);
  });

  it("plans a voicemail (say + record) as [say, record, hangup]", () => {
    const { plan } = planInitialCommand(
      decision(
        { type: "say", text: "leave a message" },
        { type: "record", maxLengthSeconds: 120, playBeep: true }
      ),
      opts
    );
    if (plan.kind !== "answer") {
      throw new Error("expected answer");
    }
    expect(decodeClientState(plan.clientState)?.q).toEqual([
      { type: "say", text: "leave a message" },
      { type: "record", maxLengthSeconds: 120, playBeep: true },
      { type: "hangup" },
    ]);
  });

  it("plans a promptless voicemail as [record, hangup]", () => {
    const { plan } = planInitialCommand(
      decision({ type: "record", maxLengthSeconds: 60, playBeep: true }),
      opts
    );
    if (plan.kind !== "answer") {
      throw new Error("expected answer");
    }
    expect(decodeClientState(plan.clientState)?.q).toEqual([
      { type: "record", maxLengthSeconds: 60, playBeep: true },
      { type: "hangup" },
    ]);
  });

  it("plans a forward sequence as [forward] with NO trailing hangup", () => {
    const { plan } = planInitialCommand(
      decision({ type: "forward", to: "+15559990000" }),
      opts
    );
    if (plan.kind !== "answer") {
      throw new Error("expected answer");
    }
    expect(decodeClientState(plan.clientState)?.q).toEqual([
      { type: "forward", to: "+15559990000" },
    ]);
  });

  it("derives the step-1 command id from the call control id", () => {
    const { commandId } = planInitialCommand(
      decision({ type: "stream" }),
      opts
    );
    expect(commandId).toBe(telnyxCommandId(CCID, 1));
  });
});

describe("advanceSequence", () => {
  function initialState(...q: RoutingAction[]): TelnyxCallState {
    return { v: 1, mode: "sequence", direction: "inbound", q, step: 1 };
  }

  it("runs a full say sequence: answered -> speak, speak.ended -> hangup, then noop", () => {
    let state = initialState(
      { type: "say", text: "hello" },
      { type: "hangup" }
    );

    const first = advanceSequence(eventWith("call.answered", "x"), state);
    expect(first.plan).toMatchObject({ kind: "speak", text: "hello" });
    if (first.plan.kind !== "speak") {
      throw new Error("expected speak");
    }
    expect(first.commandId).toBe(telnyxCommandId(CCID, 2));
    const afterSpeak = decodeClientState(first.plan.clientState);
    expect(afterSpeak?.q).toEqual([{ type: "hangup" }]);
    expect(afterSpeak?.step).toBe(2);

    state = afterSpeak as TelnyxCallState;
    const second = advanceSequence(eventWith("call.speak.ended", "x"), state);
    expect(second.plan.kind).toBe("hangup");
    expect(second.commandId).toBe(telnyxCommandId(CCID, 3));
    if (second.plan.kind !== "hangup") {
      throw new Error("expected hangup");
    }
    const afterHangup = decodeClientState(second.plan.clientState as string);
    expect(afterHangup?.q).toEqual([]);

    // Queue now empty -> any further advancing event is a noop.
    const third = advanceSequence(
      eventWith("call.hangup", "x"),
      afterHangup as TelnyxCallState
    );
    expect(third.plan).toEqual({ kind: "noop" });
  });

  it("runs a voicemail sequence: answered -> speak, speak.ended -> record, recording.saved -> hangup", () => {
    let state = initialState(
      { type: "say", text: "leave a message" },
      { type: "record", maxLengthSeconds: 120, playBeep: true },
      { type: "hangup" }
    );

    const s1 = advanceSequence(eventWith("call.answered", "x"), state);
    expect(s1.plan).toMatchObject({ kind: "speak", text: "leave a message" });
    state = decodeClientState(
      (s1.plan as { clientState: string }).clientState
    ) as TelnyxCallState;

    const s2 = advanceSequence(eventWith("call.speak.ended", "x"), state);
    expect(s2.plan).toMatchObject({
      kind: "record",
      maxLengthSeconds: 120,
      playBeep: true,
    });
    state = decodeClientState(
      (s2.plan as { clientState: string }).clientState
    ) as TelnyxCallState;

    const s3 = advanceSequence(eventWith("call.recording.saved", "x"), state);
    expect(s3.plan.kind).toBe("hangup");
  });

  it("maps forward -> transfer with to/from/timeout", () => {
    const state = initialState({
      type: "forward",
      to: "+15559990000",
      callerId: "+15551110000",
      timeoutSeconds: 25,
    });
    const { plan } = advanceSequence(eventWith("call.answered", "x"), state);
    expect(plan).toMatchObject({
      kind: "transfer",
      to: "+15559990000",
      from: "+15551110000",
      timeoutSecs: 25,
    });
  });

  it("always no-ops in stream mode", () => {
    const state: TelnyxCallState = {
      v: 1,
      mode: "stream",
      direction: "inbound",
      q: [],
      step: 1,
    };
    for (const type of [
      "call.answered",
      "call.speak.ended",
      "call.media.streaming.started",
      "call.hangup",
    ]) {
      expect(advanceSequence(eventWith(type, "x"), state).plan).toEqual({
        kind: "noop",
      });
    }
  });

  it("no-ops on unknown events and on an empty queue", () => {
    const withQueue = initialState({ type: "say", text: "hi" });
    expect(
      advanceSequence(eventWith("call.dtmf.received", "x"), withQueue).plan
    ).toEqual({ kind: "noop" });

    const empty = initialState();
    expect(
      advanceSequence(eventWith("call.answered", "x"), empty).plan
    ).toEqual({ kind: "noop" });
  });

  it("recomputes an identical plan and command id for a duplicate event", () => {
    const state = initialState(
      { type: "say", text: "hello" },
      { type: "hangup" }
    );
    const a = advanceSequence(eventWith("call.answered", "x"), state);
    const b = advanceSequence(eventWith("call.answered", "x"), state);
    expect(a).toEqual(b);
    expect(a.commandId).toBe(b.commandId);
  });
});

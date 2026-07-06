import { describe, expect, it, vi } from "vitest";
import { EventBus } from "./bus";
import type { CallEventMap } from "./events";
import { SessionTelemetry } from "./telemetry";

describe("SessionTelemetry.mark", () => {
  it("pushes marks to the marks array in order", () => {
    const telemetry = new SessionTelemetry("s1");
    telemetry.mark("a");
    telemetry.mark("b");
    expect(telemetry.marks.map((m) => m.name)).toEqual(["a", "b"]);
  });

  it("stamps sessionId and a numeric `at` on every mark", () => {
    const telemetry = new SessionTelemetry("session-9");
    const mark = telemetry.mark("something");
    expect(mark.sessionId).toBe("session-9");
    expect(typeof mark.at).toBe("number");
  });

  it("lifts stage/turnIndex out of detail onto the mark, keeping the rest under detail", () => {
    const telemetry = new SessionTelemetry("s1");
    const mark = telemetry.mark("thing", {
      stage: "vad",
      turnIndex: 2,
      foo: "bar",
    });
    expect(mark.stage).toBe("vad");
    expect(mark.turnIndex).toBe(2);
    expect(mark.detail).toEqual({ foo: "bar" });
  });

  it("omits detail entirely when there's nothing left after stage/turnIndex", () => {
    const telemetry = new SessionTelemetry("s1");
    const mark = telemetry.mark("thing", { stage: "vad" });
    expect(mark.detail).toBeUndefined();
  });

  it("forwards every mark to a provided sink", () => {
    const sink = vi.fn();
    const telemetry = new SessionTelemetry("s1", { sink });
    const mark = telemetry.mark("a");
    expect(sink).toHaveBeenCalledWith(mark);
  });

  it("defaults to debug-logging via the logger when no sink is provided", () => {
    const debug = vi.fn();
    const telemetry = new SessionTelemetry("s1", {
      logger: {
        debug,
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });
    telemetry.mark("a");
    expect(debug).toHaveBeenCalledTimes(1);
  });
});

describe("SessionTelemetry.observe", () => {
  function makeBus() {
    return new EventBus<CallEventMap>("s1");
  }

  it("marks first-audio-frame only once", () => {
    const bus = makeBus();
    const telemetry = new SessionTelemetry("s1");
    telemetry.observe(bus);
    const frame = { samples: new Int16Array(320), timestamp: 0 };
    bus.publish("audio-frame", { frame });
    bus.publish("audio-frame", { frame });
    bus.publish("audio-frame", { frame });
    expect(
      telemetry.marks.filter((m) => m.name === "first-audio-frame")
    ).toHaveLength(1);
  });

  it("marks call-ended", () => {
    const bus = makeBus();
    const telemetry = new SessionTelemetry("s1");
    telemetry.observe(bus);
    bus.publish("call-ended", { sessionId: "s1", reason: "hangup" });
    expect(telemetry.marks.filter((m) => m.name === "call-ended")).toHaveLength(
      1
    );
  });

  it("supports say-called marks made directly (not via a bus event)", () => {
    const telemetry = new SessionTelemetry("s1");
    const mark = telemetry.mark("say-called", { turnIndex: 1 });
    expect(mark.name).toBe("say-called");
    expect(mark.turnIndex).toBe(1);
  });

  it("republishes every mark as a telemetry bus event once observing, without looping", () => {
    const bus = makeBus();
    const telemetry = new SessionTelemetry("s1");
    const telemetryEvents: string[] = [];
    bus.subscribe("telemetry", ({ mark }) => telemetryEvents.push(mark.name));
    telemetry.observe(bus);

    telemetry.mark("custom-a");
    telemetry.mark("custom-b");

    expect(telemetryEvents).toEqual(["custom-a", "custom-b"]);
    // No infinite loop: exactly 2 telemetry events for 2 marks.
    expect(telemetryEvents).toHaveLength(2);
  });

  it("stops marking after the returned unsubscribe-all is called", () => {
    const bus = makeBus();
    const telemetry = new SessionTelemetry("s1");
    const stopObserving = telemetry.observe(bus);
    stopObserving();
    const frame = { samples: new Int16Array(320), timestamp: 0 };
    bus.publish("audio-frame", { frame });
    expect(telemetry.marks).toHaveLength(0);
  });
});

describe("SessionTelemetry.flush", () => {
  it("is idempotent", () => {
    const telemetry = new SessionTelemetry("s1");
    telemetry.flush();
    telemetry.flush();
    expect(telemetry.marks).toHaveLength(0);
  });
});

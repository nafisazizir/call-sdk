import { describe, expect, it } from "vitest";
import {
  type Adapter,
  AdapterError,
  CANONICAL_FORMAT,
  ConsoleLogger,
  EventBus,
  FrameChunker,
  mulawDecode,
  mulawEncode,
  SessionTelemetry,
  type Stage,
} from "./index";

describe("call-sdk placeholder contracts", () => {
  it("exposes an Adapter shape with a readonly name", () => {
    const adapter: Adapter = { name: "placeholder" };
    expect(adapter.name).toBe("placeholder");
  });

  it("exposes a Stage shape with a readonly name", () => {
    const stage: Stage = { name: "placeholder" };
    expect(stage.name).toBe("placeholder");
  });
});

describe("call-sdk M2 exports smoke test", () => {
  it("re-exports the audio primitives", () => {
    expect(CANONICAL_FORMAT.sampleRate).toBe(16_000);
    const chunker = new FrameChunker();
    expect(chunker.push(new Int16Array(320))).toHaveLength(1);
    expect(mulawDecode(mulawEncode(Int16Array.of(0)))[0]).toBe(0);
  });

  it("re-exports a working EventBus", () => {
    const bus = new EventBus("s1");
    let received = 0;
    bus.subscribe("call-answered", () => {
      received++;
    });
    bus.publish("call-answered", { sessionId: "s1" });
    expect(received).toBe(1);
  });

  it("re-exports logger and errors", () => {
    expect(new ConsoleLogger()).toBeInstanceOf(ConsoleLogger);
    expect(new AdapterError("boom")).toBeInstanceOf(Error);
  });

  it("re-exports a working SessionTelemetry", () => {
    const telemetry = new SessionTelemetry("s1");
    const mark = telemetry.mark("boot");
    expect(mark.name).toBe("boot");
    expect(telemetry.marks).toHaveLength(1);
  });
});

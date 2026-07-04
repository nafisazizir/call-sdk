import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "./logger";
import { ConsoleLogger, childLogger, createLogger } from "./logger";

describe("ConsoleLogger", () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {
      // silence
    });
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {
      // silence
    });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      // silence
    });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // silence
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to info level: suppresses debug, logs info/warn/error", () => {
    const logger = new ConsoleLogger();
    logger.debug("hidden");
    logger.info("visible");
    logger.warn("visible");
    logger.error("visible");
    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith("[call-sdk] visible");
    expect(warnSpy).toHaveBeenCalledWith("[call-sdk] visible");
    expect(errorSpy).toHaveBeenCalledWith("[call-sdk] visible");
  });

  it("debug level logs everything", () => {
    const logger = new ConsoleLogger("debug");
    logger.debug("dbg");
    logger.info("inf");
    expect(debugSpy).toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalled();
  });

  it("silent level suppresses everything", () => {
    const logger = new ConsoleLogger("silent");
    logger.debug("x");
    logger.info("x");
    logger.warn("x");
    logger.error("x");
    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("uses a custom prefix", () => {
    const logger = new ConsoleLogger("info", "my-stage");
    logger.info("hi");
    expect(infoSpy).toHaveBeenCalledWith("[my-stage] hi");
  });

  it("passes fields through as a second argument only when present", () => {
    const logger = new ConsoleLogger("debug");
    logger.debug("no fields");
    expect(debugSpy).toHaveBeenCalledWith("[call-sdk] no fields");

    logger.debug("with fields", { a: 1 });
    expect(debugSpy).toHaveBeenCalledWith("[call-sdk] with fields", { a: 1 });
  });

  it("omits an empty fields object rather than logging it", () => {
    const logger = new ConsoleLogger("debug");
    logger.debug("empty fields", {});
    expect(debugSpy).toHaveBeenCalledWith("[call-sdk] empty fields");
  });
});

describe("createLogger", () => {
  it("returns a ConsoleLogger at the given level when passed a level string", () => {
    const infoSpy = vi.spyOn(console, "debug").mockImplementation(() => {
      // silence
    });
    const logger = createLogger("debug");
    logger.debug("hi");
    expect(infoSpy).toHaveBeenCalled();
    infoSpy.mockRestore();
  });

  it("defaults to info level when called with no argument", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {
      // silence
    });
    createLogger().debug("hidden");
    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it("passes an already-constructed Logger through unchanged", () => {
    const custom: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    expect(createLogger(custom)).toBe(custom);
  });
});

describe("childLogger", () => {
  it("prefixes messages with stage and sessionId", () => {
    const parent: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const child = childLogger(parent, { stage: "vad", sessionId: "sess-1" });
    child.info("hello");
    // Bindings are also merged into fields (not just the message prefix) so
    // structured-log transports can filter/aggregate on them.
    expect(parent.info).toHaveBeenCalledWith("[vad:sess-1] hello", {
      stage: "vad",
      sessionId: "sess-1",
    });
  });

  it("merges bindings into fields, letting explicit fields win on key clash", () => {
    const parent: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const child = childLogger(parent, { stage: "vad" });
    child.warn("uh oh", { stage: "override", extra: 1 });
    expect(parent.warn).toHaveBeenCalledWith("[vad] uh oh", {
      stage: "override",
      extra: 1,
    });
  });

  it("passes fields through unmodified when there are no bindings", () => {
    const parent: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const child = childLogger(parent, {});
    child.error("plain", { a: 1 });
    expect(parent.error).toHaveBeenCalledWith("plain", { a: 1 });
  });

  it("works when wrapping another child logger (nested context)", () => {
    const calls: [string, unknown][] = [];
    const parent: Logger = {
      debug: vi.fn(),
      info: (msg, fields) => calls.push([msg, fields]),
      warn: vi.fn(),
      error: vi.fn(),
    };
    // Each layer wraps the message/fields produced by the layer inside it,
    // so nesting reads outside-in: the outermost binding's prefix ends up
    // leftmost, and both layers' bindings end up merged into fields.
    const stageLogger = childLogger(parent, { stage: "tts" });
    const sessionStageLogger = childLogger(stageLogger, {
      sessionId: "sess-2",
    });
    sessionStageLogger.info("go");
    expect(calls).toEqual([
      ["[tts] [sess-2] go", { stage: "tts", sessionId: "sess-2" }],
    ]);
  });
});

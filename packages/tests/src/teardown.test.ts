import { Call } from "call-sdk";
import { describe, expect, it } from "vitest";
import { createMockAdapter } from "./factories";
import { recordEvents } from "./matchers";

describe("mock adapter teardown & exactly-once semantics", () => {
  it("emits exactly one call-ended under concurrent hangup / end / fail", async () => {
    // Pure transport/session behavior — no voice pipeline needed.
    const adapter = createMockAdapter("mock");
    const call = new Call({ adapters: { mock: adapter }, logger: "silent" });
    const driver = adapter.connectCall();
    const session = call.getSession(driver.sessionId);
    if (!session) {
      throw new Error("no session");
    }
    const recorded = recordEvents(session.bus);

    driver.hangup();
    const endPromise = session.end();
    driver.fail(new Error("boom"));

    await endPromise;
    await session.ended;

    expect(recorded).toHaveEndedOnce();
    expect(call.sessions.has(session.id)).toBe(false);
  });
});

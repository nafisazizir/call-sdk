import { describe, expect, it } from "vitest";
import { createTwilioAdapter, TwilioAdapter } from "./index";

describe("createTwilioAdapter", () => {
  it("creates a TwilioAdapter instance named 'twilio'", () => {
    const adapter = createTwilioAdapter();
    expect(adapter).toBeInstanceOf(TwilioAdapter);
    expect(adapter.name).toBe("twilio");
  });
});

import { describe, expect, it } from "vitest";
import { createTwilioAdapter, TwilioAdapter } from "./index";

describe("createTwilioAdapter", () => {
  it("creates a TwilioAdapter instance named 'twilio'", () => {
    const adapter = createTwilioAdapter();
    expect(adapter).toBeInstanceOf(TwilioAdapter);
    expect(adapter.name).toBe("twilio");
  });

  it("throws not-implemented for I/O methods until M4", () => {
    const adapter = createTwilioAdapter();
    expect(() => adapter.media({} as never)).toThrow("not implemented");
    expect(() => adapter.webhook(new Request("http://x"))).toThrow(
      "not implemented"
    );
    expect(() => adapter.startCall({ to: "+100" })).toThrow("not implemented");
  });
});

import { describe, expect, it } from "vitest";
import { connectStreamTwiml } from "./twiml";

describe("connectStreamTwiml", () => {
  it("generates a Connect/Stream response with no parameters", () => {
    const xml = connectStreamTwiml("wss://example.com/twilio/media");
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://example.com/twilio/media"></Stream></Connect></Response>'
    );
  });

  it("emits one Parameter tag per entry, in insertion order", () => {
    const xml = connectStreamTwiml("wss://example.com/twilio/media", {
      from: "+15551234567",
      to: "+15557654321",
      direction: "inbound",
    });
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://example.com/twilio/media">' +
        '<Parameter name="from" value="+15551234567"/>' +
        '<Parameter name="to" value="+15557654321"/>' +
        '<Parameter name="direction" value="inbound"/>' +
        "</Stream></Connect></Response>"
    );
  });

  it("XML-escapes unsafe characters in both the URL and parameter values", () => {
    const xml = connectStreamTwiml("wss://example.com/media?a=1&b=2", {
      name: `Bob "the <builder>" & co`,
    });
    expect(xml).toContain('url="wss://example.com/media?a=1&amp;b=2"');
    expect(xml).toContain(
      '<Parameter name="name" value="Bob &quot;the &lt;builder&gt;&quot; &amp; co"/>'
    );
    expect(xml).not.toContain("<builder>");
  });

  it("escapes apostrophes", () => {
    const xml = connectStreamTwiml("wss://example.com/media", {
      name: "O'Brien",
    });
    expect(xml).toContain('value="O&apos;Brien"');
  });
});

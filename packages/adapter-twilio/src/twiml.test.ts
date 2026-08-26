import type { RoutingAction, RoutingDecision } from "call-sdk";
import { AdapterError } from "call-sdk";
import { describe, expect, it } from "vitest";
import {
  connectStreamTwiml,
  escapeXmlText,
  routingDecisionTwiml,
} from "./twiml";

function decisionOf(...actions: RoutingAction[]): RoutingDecision {
  return { kind: "call-sdk/routing-decision", actions };
}

const NOOP_CTX = {
  actionUrl: (action: string) =>
    `https://example.com/wh?call_sdk_action=${action}`,
};
const UNKNOWN_ACTION_MESSAGE_RE = /cannot express routing action "teleport"/;

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

describe("escapeXmlText", () => {
  it("escapes & < > but leaves quotes untouched", () => {
    expect(escapeXmlText(`& < > " '`)).toBe(`&amp; &lt; &gt; " '`);
  });
});

describe("routingDecisionTwiml", () => {
  it("translates reject", () => {
    const xml = routingDecisionTwiml(
      decisionOf({ type: "reject", reason: "rejected" }),
      NOOP_CTX
    );
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected"/></Response>'
    );
  });

  it("translates a busy reject", () => {
    const xml = routingDecisionTwiml(
      decisionOf({ type: "reject", reason: "busy" }),
      NOOP_CTX
    );
    expect(xml).toContain('<Reject reason="busy"/>');
  });

  it("translates hangup", () => {
    const xml = routingDecisionTwiml(decisionOf({ type: "hangup" }), NOOP_CTX);
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'
    );
  });

  it("translates forward with the number as text content, no optional attrs when unset", () => {
    const xml = routingDecisionTwiml(
      decisionOf({ type: "forward", to: ["+15551234567"] }),
      NOOP_CTX
    );
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Number>+15551234567</Number></Dial></Response>'
    );
  });

  it("translates a multi-number forward as one Dial with a Number per destination (simultaneous ring)", () => {
    const xml = routingDecisionTwiml(
      decisionOf({
        type: "forward",
        to: ["+15551234567", "+15557654321", "+1 & <555>"],
      }),
      NOOP_CTX
    );
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Number>+15551234567</Number><Number>+15557654321</Number><Number>+1 &amp; &lt;555&gt;</Number></Dial></Response>'
    );
  });

  it("translates forward with callerId and timeoutSeconds attributes", () => {
    const xml = routingDecisionTwiml(
      decisionOf({
        type: "forward",
        to: ["+15551234567"],
        callerId: `+1 "caller" & <co>`,
        timeoutSeconds: 20,
      }),
      NOOP_CTX
    );
    expect(xml).toContain(
      '<Dial callerId="+1 &quot;caller&quot; &amp; &lt;co&gt;" timeout="20">'
    );
    expect(xml).toContain("<Number>+15551234567</Number></Dial>");
  });

  it("escapes the forward number as text content", () => {
    const xml = routingDecisionTwiml(
      decisionOf({ type: "forward", to: ["+1 & <555>"] }),
      NOOP_CTX
    );
    expect(xml).toContain("<Number>+1 &amp; &lt;555&gt;</Number>");
  });

  it("translates say with no attrs when voice/language are unset", () => {
    const xml = routingDecisionTwiml(
      decisionOf({ type: "say", text: "Hello there" }),
      NOOP_CTX
    );
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Hello there</Say></Response>'
    );
  });

  it("translates say with voice/language attrs and text-escapes the body", () => {
    const xml = routingDecisionTwiml(
      decisionOf({
        type: "say",
        text: `Tom & Jerry <said> "hi" 'there'`,
        voice: "Polly.Joanna",
        language: "en-US",
      }),
      NOOP_CTX
    );
    expect(xml).toContain(
      '<Say voice="Polly.Joanna" language="en-US">Tom &amp; Jerry &lt;said&gt; "hi" \'there\'</Say>'
    );
  });

  it("translates play with a text-escaped URL", () => {
    const xml = routingDecisionTwiml(
      decisionOf({ type: "play", url: "https://example.com/a.mp3?x=1&y=2" }),
      NOOP_CTX
    );
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Play>https://example.com/a.mp3?x=1&amp;y=2</Play></Response>'
    );
  });

  it("translates record with a mandatory, attr-escaped action URL", () => {
    const xml = routingDecisionTwiml(
      decisionOf({ type: "record", maxLengthSeconds: 90, playBeep: false }),
      NOOP_CTX
    );
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Record action="https://example.com/wh?call_sdk_action=hangup" maxLength="90" playBeep="false"/></Response>'
    );
  });

  it("composes voicemail (say then record) as one Response, in order", () => {
    const xml = routingDecisionTwiml(
      decisionOf(
        { type: "say", text: "Leave a message after the tone" },
        { type: "record", maxLengthSeconds: 120, playBeep: true }
      ),
      NOOP_CTX
    );
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        "<Say>Leave a message after the tone</Say>" +
        '<Record action="https://example.com/wh?call_sdk_action=hangup" maxLength="120" playBeep="true"/>' +
        "</Response>"
    );
  });

  it("throws AdapterError for a stream action — handled via connectStreamTwiml, never here", () => {
    expect(() =>
      routingDecisionTwiml(decisionOf({ type: "stream" }), NOOP_CTX)
    ).toThrow(AdapterError);
  });

  it("throws AdapterError naming the action type for an unknown action", () => {
    const bogus = { type: "teleport" } as unknown as RoutingAction;
    expect(() => routingDecisionTwiml(decisionOf(bogus), NOOP_CTX)).toThrow(
      UNKNOWN_ACTION_MESSAGE_RE
    );
  });
});

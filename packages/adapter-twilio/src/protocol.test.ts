import { describe, expect, it } from "vitest";
import {
  parseTwilioMessage,
  serializeTwilioClear,
  serializeTwilioMark,
  serializeTwilioMedia,
  type TwilioMediaMessage,
  type TwilioStartMessage,
} from "./protocol";

describe("parseTwilioMessage", () => {
  it("parses a connected message", () => {
    const msg = parseTwilioMessage(
      JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" })
    );
    expect(msg).toEqual({
      event: "connected",
      protocol: "Call",
      version: "1.0.0",
    });
  });

  it("parses a start message with customParameters", () => {
    const raw = {
      event: "start",
      sequenceNumber: "1",
      streamSid: "MZ123",
      start: {
        streamSid: "MZ123",
        accountSid: "AC123",
        callSid: "CA123",
        tracks: ["inbound"],
        customParameters: { from: "+15551234567", direction: "inbound" },
        mediaFormat: {
          encoding: "audio/x-mulaw",
          sampleRate: 8000,
          channels: 1,
        },
      },
    };
    const msg = parseTwilioMessage(JSON.stringify(raw)) as TwilioStartMessage;
    expect(msg.event).toBe("start");
    expect(msg.start.callSid).toBe("CA123");
    expect(msg.start.customParameters?.from).toBe("+15551234567");
  });

  it("parses a media message", () => {
    const raw = {
      event: "media",
      sequenceNumber: "2",
      streamSid: "MZ123",
      media: {
        track: "inbound",
        chunk: "1",
        timestamp: "160",
        payload: "//79",
      },
    };
    const msg = parseTwilioMessage(JSON.stringify(raw)) as TwilioMediaMessage;
    expect(msg.event).toBe("media");
    expect(msg.media.payload).toBe("//79");
  });

  it("parses a mark message", () => {
    const msg = parseTwilioMessage(
      JSON.stringify({
        event: "mark",
        streamSid: "MZ123",
        mark: { name: "utt_1" },
      })
    );
    expect(msg).toEqual({
      event: "mark",
      streamSid: "MZ123",
      mark: { name: "utt_1" },
    });
  });

  it("parses a stop message", () => {
    const msg = parseTwilioMessage(
      JSON.stringify({
        event: "stop",
        streamSid: "MZ123",
        stop: { accountSid: "AC123", callSid: "CA123" },
      })
    );
    expect(msg).toEqual({
      event: "stop",
      streamSid: "MZ123",
      stop: { accountSid: "AC123", callSid: "CA123" },
    });
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseTwilioMessage("not json")).toBeUndefined();
  });

  it("returns undefined for an unrecognized event", () => {
    expect(
      parseTwilioMessage(JSON.stringify({ event: "dtmf", digit: "5" }))
    ).toBeUndefined();
  });

  it("returns undefined for a recognized event with a malformed payload", () => {
    expect(
      parseTwilioMessage(JSON.stringify({ event: "media", streamSid: "MZ123" }))
    ).toBeUndefined();
  });

  it("returns undefined for a JSON value that isn't an object", () => {
    expect(parseTwilioMessage(JSON.stringify(["nope"]))).toBeUndefined();
    expect(parseTwilioMessage(JSON.stringify(42))).toBeUndefined();
  });
});

describe("serialize round-trips", () => {
  it("serializes a media message", () => {
    // Outbound (adapter -> Twilio) media messages only need `payload` —
    // Twilio doesn't require (and `parseTwilioMessage`'s stricter inbound
    // shape doesn't accept) track/chunk/timestamp on this direction, so this
    // asserts the raw JSON shape rather than round-tripping through the
    // inbound parser.
    const wire = serializeTwilioMedia("MZ123", "//79");
    expect(JSON.parse(wire)).toEqual({
      event: "media",
      streamSid: "MZ123",
      media: { payload: "//79" },
    });
  });

  it("serializes a mark message", () => {
    const wire = serializeTwilioMark("MZ123", "utt_7");
    expect(JSON.parse(wire)).toEqual({
      event: "mark",
      streamSid: "MZ123",
      mark: { name: "utt_7" },
    });
  });

  it("serializes a clear message", () => {
    const wire = serializeTwilioClear("MZ123");
    expect(JSON.parse(wire)).toEqual({ event: "clear", streamSid: "MZ123" });
  });
});

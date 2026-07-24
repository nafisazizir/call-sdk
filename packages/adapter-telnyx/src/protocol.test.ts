import { describe, expect, it } from "vitest";
import {
  parseTelnyxMessage,
  serializeTelnyxClear,
  serializeTelnyxMark,
  serializeTelnyxMedia,
  type TelnyxMediaMessage,
  type TelnyxStartMessage,
} from "./protocol";

describe("parseTelnyxMessage", () => {
  it("parses a connected message", () => {
    const msg = parseTelnyxMessage(JSON.stringify({ event: "connected" }));
    expect(msg).toEqual({ event: "connected" });
  });

  it("parses a start message with client_state/from/to", () => {
    const raw = {
      event: "start",
      stream_id: "stream-123",
      start: {
        call_control_id: "v3:call-control-id",
        client_state: "eyJmb28iOiJiYXIifQ==",
        from: "+15551234567",
        to: "+15557654321",
        media_format: {
          encoding: "PCMU",
          sample_rate: 8000,
          channels: 1,
        },
      },
    };
    const msg = parseTelnyxMessage(JSON.stringify(raw)) as TelnyxStartMessage;
    expect(msg.event).toBe("start");
    expect(msg.stream_id).toBe("stream-123");
    expect(msg.start.call_control_id).toBe("v3:call-control-id");
    expect(msg.start.from).toBe("+15551234567");
    expect(msg.start.client_state).toBe("eyJmb28iOiJiYXIifQ==");
  });

  it("parses a start message without optional fields", () => {
    const raw = {
      event: "start",
      stream_id: "stream-123",
      start: {
        call_control_id: "v3:call-control-id",
        media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 },
      },
    };
    const msg = parseTelnyxMessage(JSON.stringify(raw)) as TelnyxStartMessage;
    expect(msg.start.from).toBeUndefined();
    expect(msg.start.to).toBeUndefined();
    expect(msg.start.client_state).toBeUndefined();
  });

  it("parses a media message", () => {
    const raw = {
      event: "media",
      media: { payload: "//79", track: "inbound" },
    };
    const msg = parseTelnyxMessage(JSON.stringify(raw)) as TelnyxMediaMessage;
    expect(msg.event).toBe("media");
    expect(msg.media.payload).toBe("//79");
    expect(msg.media.track).toBe("inbound");
  });

  it("parses a mark message", () => {
    const msg = parseTelnyxMessage(
      JSON.stringify({ event: "mark", mark: { name: "utt_1" } })
    );
    expect(msg).toEqual({ event: "mark", mark: { name: "utt_1" } });
  });

  it("parses a stop message", () => {
    const msg = parseTelnyxMessage(
      JSON.stringify({ event: "stop", sequence_number: "9" })
    );
    expect(msg).toEqual({ event: "stop", sequence_number: "9" });
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseTelnyxMessage("not json")).toBeUndefined();
  });

  it("returns undefined for an unrecognized event", () => {
    expect(
      parseTelnyxMessage(JSON.stringify({ event: "dtmf", digit: "5" }))
    ).toBeUndefined();
  });

  it("returns undefined for a start message missing call_control_id", () => {
    expect(
      parseTelnyxMessage(
        JSON.stringify({
          event: "start",
          stream_id: "stream-123",
          start: {
            media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 },
          },
        })
      )
    ).toBeUndefined();
  });

  it("returns undefined for a start message missing media_format", () => {
    expect(
      parseTelnyxMessage(
        JSON.stringify({
          event: "start",
          stream_id: "stream-123",
          start: { call_control_id: "v3:call-control-id" },
        })
      )
    ).toBeUndefined();
  });

  it("returns undefined for a media message missing payload", () => {
    expect(
      parseTelnyxMessage(JSON.stringify({ event: "media", media: {} }))
    ).toBeUndefined();
  });

  it("returns undefined for a mark message missing name", () => {
    expect(
      parseTelnyxMessage(JSON.stringify({ event: "mark", mark: {} }))
    ).toBeUndefined();
  });

  it("returns undefined for a JSON value that isn't an object", () => {
    expect(parseTelnyxMessage(JSON.stringify(["nope"]))).toBeUndefined();
    expect(parseTelnyxMessage(JSON.stringify(42))).toBeUndefined();
  });
});

describe("serialize round-trips", () => {
  it("serializes a media message with no stream id", () => {
    const wire = serializeTelnyxMedia("//79");
    const parsed = JSON.parse(wire);
    expect(parsed).toEqual({ event: "media", media: { payload: "//79" } });
    expect(parsed).not.toHaveProperty("stream_id");
    expect(parsed).not.toHaveProperty("streamSid");
  });

  it("serializes a mark message with no stream id", () => {
    const wire = serializeTelnyxMark("utt_7");
    const parsed = JSON.parse(wire);
    expect(parsed).toEqual({ event: "mark", mark: { name: "utt_7" } });
    expect(parsed).not.toHaveProperty("stream_id");
  });

  it("serializes a clear message with no stream id", () => {
    const wire = serializeTelnyxClear();
    const parsed = JSON.parse(wire);
    expect(parsed).toEqual({ event: "clear" });
    expect(parsed).not.toHaveProperty("stream_id");
  });
});

import { describe, expect, it } from "vitest";
import { mulawDecode, mulawEncode } from "./mulaw";

/**
 * Golden byte -> PCM16 pairs, derived directly from the standard G.711
 * μ-law decode formula (see the reference comment in mulaw.ts) and
 * cross-checked by hand against the well-known published 256-entry decode
 * table it produces. Includes the four bytes called out explicitly by the
 * spec (0x00, 0x7F, 0x80, 0xFF) plus four more spanning both halves and
 * segments.
 */
const GOLDEN_VECTORS: [byte: number, pcm: number][] = [
  [0x00, -32_124],
  [0x01, -31_100],
  [0x0f, -16_764],
  [0x7e, -8],
  [0x7f, 0],
  [0x80, 32_124],
  [0xfe, 8],
  [0xff, 0],
];

describe("mulawDecode golden vectors", () => {
  for (const [byte, pcm] of GOLDEN_VECTORS) {
    it(`decodes 0x${byte.toString(16).padStart(2, "0")} to ${pcm}`, () => {
      const [decoded] = mulawDecode(Uint8Array.of(byte));
      expect(decoded).toBe(pcm);
    });
  }

  it("decodes a full buffer matching each byte's golden PCM value", () => {
    const bytes = Uint8Array.from(GOLDEN_VECTORS.map(([byte]) => byte));
    const decoded = mulawDecode(bytes);
    expect(Array.from(decoded)).toEqual(GOLDEN_VECTORS.map(([, pcm]) => pcm));
  });
});

describe("mulaw zero-code convention", () => {
  it("both 0x7F and 0xFF decode to PCM 0 (positive/negative zero)", () => {
    expect(mulawDecode(Uint8Array.of(0x7f))[0]).toBe(0);
    expect(mulawDecode(Uint8Array.of(0xff))[0]).toBe(0);
  });

  it("encodes a zero-valued sample to the canonical 0xFF", () => {
    expect(mulawEncode(Int16Array.of(0))[0]).toBe(0xff);
  });
});

describe("mulawEncode / mulawDecode round-trip", () => {
  it("decode -> encode reproduces the original byte for every value except the redundant negative-zero code 0x7F", () => {
    for (let byte = 0; byte < 256; byte++) {
      const [pcm] = mulawDecode(Uint8Array.of(byte));
      const [reencoded] = mulawEncode(Int16Array.of(pcm));
      if (byte === 0x7f) {
        // 0x7F is "negative zero"; both it and 0xFF decode to 0, and
        // encoding canonicalizes to 0xFF. No audio information is lost —
        // only this redundant byte-level encoding of zero is not
        // preserved.
        expect(reencoded).toBe(0xff);
      } else {
        expect(reencoded).toBe(byte);
      }
    }
  });

  it("encode -> decode round-trips within bounded quantization error", () => {
    // μ-law is a companding codec: quantization step size grows with
    // magnitude, so round-trip error scales with the input's magnitude.
    // This generous, magnitude-relative bound comfortably covers the
    // largest possible step at any segment while still catching gross
    // errors (e.g. sign flips, wrong segment math).
    const sampleValues = [
      -32_768, -30_000, -20_000, -10_000, -1000, -100, -1, 0, 1, 100, 1000,
      10_000, 20_000, 30_000, 32_767,
    ];
    for (const value of sampleValues) {
      const [encoded] = mulawEncode(Int16Array.of(value));
      const [decoded] = mulawDecode(Uint8Array.of(encoded));
      const tolerance = Math.abs(value) * 0.05 + 16;
      expect(Math.abs(decoded - value)).toBeLessThanOrEqual(tolerance);
    }
  });
});

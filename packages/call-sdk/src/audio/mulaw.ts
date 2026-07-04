/**
 * G.711 μ-law ("PCMU") codec.
 *
 * Twilio's raw media stream (and most PSTN telephony gear) carries audio as
 * 8kHz μ-law bytes; this module converts between that wire format and
 * linear PCM16 samples.
 *
 * Reference: the classic μ-law transcoding algorithm that originates from
 * Sun Microsystems' public-domain `g711.c` / the CCITT G.711 (1988)
 * reference implementation. It has been reproduced near-verbatim in
 * countless open-source codecs since (ffmpeg's `libavcodec/g711.c`, SoX,
 * Asterisk's `codec_ulaw`, BSD's audio drivers, etc.), and is the de facto
 * standard implementation. `decodeByte` below is that reference's bit-level
 * decode formula; `DECODE_TABLE` precomputes it for all 256 byte values.
 * `encodeSample` is the companion segment/search encode algorithm from the
 * same reference family. The golden vectors in `mulaw.test.ts` were derived
 * directly from this formula (by hand, then cross-checked against the
 * well-known published 256-entry decode table it produces).
 *
 * A quirk of μ-law worth calling out explicitly: it has *two* zero codes.
 * Byte `0x7F` ("negative zero") and byte `0xFF` ("positive zero") both
 * decode to PCM `0`. This isn't a bug — it falls out of the sign-magnitude
 * encoding — and telephony convention (Twilio included) treats `0xFF` as
 * the canonical digital-silence byte. `mulawEncode` therefore always
 * canonicalizes a zero-valued sample to `0xFF`. One consequence: encoding a
 * decoded byte reproduces the original byte for every value except `0x7F`,
 * which canonicalizes to `0xFF` (both represent the same PCM value, so no
 * audio information is lost — only the redundant byte-level encoding of
 * zero is not preserved). This is intentional and is exercised explicitly
 * in the test suite rather than papered over.
 */

const BIAS = 0x84; // 132 — see reference implementation
const SIGN_BIT = 0x80;
const QUANT_MASK = 0x0f;
const SEG_SHIFT = 4;
const SEG_MASK = 0x70;

/** Upper bound (inclusive) of each of the 8 encode segments, in the biased linear domain. */
const SEG_END = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff];

function decodeByte(rawByte: number): number {
  // The wire byte is the bitwise complement of the "logical" sign/segment/
  // quantization code — μ-law transmits ~code, not code, on the line.
  // biome-ignore lint/suspicious/noBitwiseOperators: G.711 is inherently a bit-level codec; these are the reference algorithm's actual bit operations, not accidental misuse.
  const uVal = ~rawByte & 0xff;
  // biome-ignore lint/suspicious/noBitwiseOperators: see above.
  let magnitude = ((uVal & QUANT_MASK) << 3) + BIAS;
  // biome-ignore lint/suspicious/noBitwiseOperators: see above.
  magnitude <<= (uVal & SEG_MASK) >> SEG_SHIFT;
  // biome-ignore lint/suspicious/noBitwiseOperators: see above.
  return (uVal & SIGN_BIT) === 0 ? magnitude - BIAS : BIAS - magnitude;
}

/** Precomputed 256-entry μ-law → PCM16 decode table (byte value -> linear sample). */
const DECODE_TABLE: Int16Array = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    table[i] = decodeByte(i);
  }
  return table;
})();

function segmentFor(biasedMagnitude: number): number {
  for (let seg = 0; seg < SEG_END.length; seg++) {
    if (biasedMagnitude <= SEG_END[seg]) {
      return seg;
    }
  }
  return SEG_END.length;
}

function encodeSample(pcmVal: number): number {
  let mask: number;
  let magnitude: number;
  if (pcmVal < 0) {
    magnitude = BIAS - pcmVal;
    mask = 0x7f;
  } else {
    magnitude = BIAS + pcmVal;
    mask = 0xff;
  }

  const seg = segmentFor(magnitude);
  if (seg >= SEG_END.length) {
    // Out of range (clipped): return the segment-7 maximum-magnitude code.
    // biome-ignore lint/suspicious/noBitwiseOperators: G.711 segment/sign encoding, not accidental bitwise use.
    return 0x7f ^ mask;
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: G.711 segment/sign encoding, not accidental bitwise use.
  const uVal = (seg << 4) | ((magnitude >> (seg + 3)) & 0x0f);
  // biome-ignore lint/suspicious/noBitwiseOperators: G.711 segment/sign encoding, not accidental bitwise use.
  return uVal ^ mask;
}

/** Decodes μ-law bytes to linear PCM16 mono samples. */
export function mulawDecode(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = DECODE_TABLE[bytes[i]];
  }
  return out;
}

/** Encodes linear PCM16 mono samples to μ-law bytes. */
export function mulawEncode(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = encodeSample(samples[i]);
  }
  return out;
}

/**
 * The canonical audio format used throughout the Call SDK pipeline.
 *
 * Every adapter normalizes its provider's native audio into this format on
 * the way in, and de-normalizes on the way out — see SPEC.md, "The Adapter
 * Contract". A single canonical format is what lets one VAD / STT / turn
 * detection configuration work identically across every provider.
 *
 * PCM16 mono @ 16 kHz was chosen as the trade-off point for v1: it is wide
 * enough for good STT/VAD accuracy while staying cheap to resample to/from
 * both 8 kHz telephony audio (Twilio) and higher WebRTC sample rates, and
 * s16le is the format nearly every STT/TTS provider accepts natively
 * without additional transcoding.
 */
export const CANONICAL_FORMAT = {
  encoding: "pcm-s16le",
  sampleRate: 16_000,
  channels: 1,
  frameMs: 20,
  samplesPerFrame: 320,
} as const;

export interface AudioFrame {
  /** PCM16 mono @ 16 kHz */
  readonly samples: Int16Array;
  /** ms since session media start (adapter media clock) */
  readonly timestamp: number;
}

/** Duration of a frame in milliseconds, derived from its actual sample count. */
export function frameDurationMs(frame: AudioFrame): number {
  return (frame.samples.length / CANONICAL_FORMAT.sampleRate) * 1000;
}

/**
 * Converts little-endian PCM16 bytes to an `Int16Array`.
 *
 * `Int16Array` uses the platform's native byte order, which in practice is
 * little-endian on every Node/V8 target this SDK runs on — but that is not
 * guaranteed by the JS spec, and provider audio on the wire is always
 * explicitly little-endian ("s16le"). We therefore read through a
 * `DataView` with an explicit `littleEndian: true` flag rather than casting
 * the buffer directly, so behavior is correct even on a big-endian host.
 */
export function bytesToInt16(bytes: Uint8Array): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = view.getInt16(i * 2, true);
  }
  return out;
}

/** Converts an `Int16Array` to little-endian PCM16 bytes. See {@link bytesToInt16}. */
export function int16ToBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * 2, samples[i], true);
  }
  return bytes;
}

export interface FrameChunkerOptions {
  /** Sample rate used to derive each frame's timestamp advance. Defaults to the canonical 16kHz. */
  sampleRate?: number;
  /** Samples per emitted frame. Defaults to the canonical 320 (20ms @ 16kHz). */
  samplesPerFrame?: number;
  /** Starting value (ms) for the first frame's timestamp. Defaults to 0. */
  startTimestamp?: number;
}

/**
 * Re-chunks arbitrary-length PCM16 audio into exact `samplesPerFrame`-sample
 * {@link AudioFrame}s with a monotonically advancing timestamp.
 *
 * Adapters and TTS stages receive audio from providers in whatever chunk
 * sizes the wire delivers (not necessarily 20ms-aligned); `FrameChunker`
 * absorbs that by keeping a small remainder buffer across `push()` calls.
 * Call `flush()` at end-of-stream to emit any partial trailing frame,
 * padded with silence up to `samplesPerFrame`.
 */
export class FrameChunker {
  private readonly samplesPerFrame: number;
  private readonly frameMs: number;
  private readonly buffer: Int16Array;
  private bufferLength = 0;
  private nextTimestamp: number;

  constructor(opts: FrameChunkerOptions = {}) {
    this.samplesPerFrame =
      opts.samplesPerFrame ?? CANONICAL_FORMAT.samplesPerFrame;
    const sampleRate = opts.sampleRate ?? CANONICAL_FORMAT.sampleRate;
    this.frameMs = (this.samplesPerFrame / sampleRate) * 1000;
    this.buffer = new Int16Array(this.samplesPerFrame);
    this.nextTimestamp = opts.startTimestamp ?? 0;
  }

  /**
   * Pushes raw PCM16 audio (as samples, or as little-endian bytes) and
   * returns as many complete frames as can now be formed. Leftover samples
   * are retained internally for the next `push()` or `flush()`.
   */
  push(input: Int16Array | Uint8Array): AudioFrame[] {
    const samples = input instanceof Int16Array ? input : bytesToInt16(input);
    const frames: AudioFrame[] = [];
    let offset = 0;
    while (offset < samples.length) {
      const need = this.samplesPerFrame - this.bufferLength;
      const take = Math.min(need, samples.length - offset);
      this.buffer.set(
        samples.subarray(offset, offset + take),
        this.bufferLength
      );
      this.bufferLength += take;
      offset += take;
      if (this.bufferLength === this.samplesPerFrame) {
        frames.push(this.emitFrame(this.buffer.slice()));
        this.bufferLength = 0;
      }
    }
    return frames;
  }

  /**
   * Flushes any buffered partial frame, right-padded with silence
   * (zero samples) up to `samplesPerFrame`. Returns `null` if there is
   * nothing buffered. Safe to call multiple times.
   */
  flush(): AudioFrame | null {
    if (this.bufferLength === 0) {
      return null;
    }
    const padded = new Int16Array(this.samplesPerFrame);
    padded.set(this.buffer.subarray(0, this.bufferLength));
    this.bufferLength = 0;
    return this.emitFrame(padded);
  }

  private emitFrame(samples: Int16Array): AudioFrame {
    const frame: AudioFrame = { samples, timestamp: this.nextTimestamp };
    this.nextTimestamp += this.frameMs;
    return frame;
  }
}

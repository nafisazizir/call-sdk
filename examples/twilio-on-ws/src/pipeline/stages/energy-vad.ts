import { type AudioFrame, CANONICAL_FORMAT } from "call-sdk";
import { frameRms, rmsToDbfs } from "../audio/rms";
import type { Stage, StageContext, StageHandle } from "../stage";

/**
 * Configuration for the built-in energy-gate VAD stage.
 *
 * Timing is expressed in milliseconds here but the stage runs entirely in
 * frame counts / {@link AudioFrame.timestamp} values internally — it arms no
 * wall-clock timers, so its behavior is fully deterministic under test.
 */
export interface EnergyVadStageConfig {
  /** Consecutive voiced frames required to fire `speech-start`. Default 3 (60ms). */
  activationFrames?: number;
  /** Consecutive silence (ms) after voice before `speech-end`. Default 300. */
  hangoverMs?: number;
  /** Rolling window (ms) the adaptive noise floor tracks over. Default 2000. */
  noiseFloorWindowMs?: number;
  /** dB above the rolling noise floor a frame must reach to count as voiced. Default 12. */
  thresholdDb?: number;
}

const DEFAULT_THRESHOLD_DB = 12;
const DEFAULT_ACTIVATION_FRAMES = 3;
const DEFAULT_HANGOVER_MS = 300;
const DEFAULT_NOISE_FLOOR_WINDOW_MS = 2000;

/** Where the noise floor starts, and the floor it is never allowed to drop below. */
const NOISE_FLOOR_INIT_DBFS = -65;
const NOISE_FLOOR_MIN_DBFS = -65;

type VadState = "silent" | "speaking";

/**
 * A simple, dependency-free energy-gate voice activity detector.
 *
 * Per frame it computes dBFS from the frame's RMS energy and compares it to an
 * adaptive noise floor (slow-rising / fast-falling). A frame is *voiced* when
 * its energy sits `thresholdDb` above the floor. `activationFrames` consecutive
 * voiced frames open a speech run (`speech-start`); `hangoverMs` worth of
 * consecutive unvoiced frames close it (`speech-end`).
 *
 * This is raw acoustic detection — "there is / isn't voice energy right now" —
 * not turn detection — turn detection is not silence detection.
 */
export class EnergyVadStage implements Stage {
  readonly name = "energy-vad";
  readonly consumes = ["audio-frame"] as const;
  readonly emits = ["speech-start", "speech-end"] as const;

  readonly #thresholdDb: number;
  readonly #activationFrames: number;
  readonly #hangoverFrames: number;
  readonly #floorAlpha: number;

  constructor(config: EnergyVadStageConfig = {}) {
    this.#thresholdDb = config.thresholdDb ?? DEFAULT_THRESHOLD_DB;
    this.#activationFrames =
      config.activationFrames ?? DEFAULT_ACTIVATION_FRAMES;
    const hangoverMs = config.hangoverMs ?? DEFAULT_HANGOVER_MS;
    this.#hangoverFrames = Math.ceil(hangoverMs / CANONICAL_FORMAT.frameMs);
    const windowMs = config.noiseFloorWindowMs ?? DEFAULT_NOISE_FLOOR_WINDOW_MS;
    // Per-frame rise coefficient: one frame moves the floor this fraction of
    // the way toward the current energy. Smaller window ⇒ faster tracking.
    this.#floorAlpha = Math.min(1, CANONICAL_FORMAT.frameMs / windowMs);
  }

  attach(ctx: StageContext): StageHandle {
    let state: VadState = "silent";
    let floorDbfs = NOISE_FLOOR_INIT_DBFS;
    let voicedRun = 0;
    let unvoicedRun = 0;
    let runStartTimestamp = 0;
    let firstUnvoicedTimestamp = 0;
    let speechStartTimestamp = 0;

    const updateFloor = (dbfs: number): void => {
      if (dbfs < floorDbfs) {
        // Fast fall toward dips in energy, clamped to the minimum.
        floorDbfs = Math.max(dbfs, NOISE_FLOOR_MIN_DBFS);
      } else {
        // Slow rise toward sustained ambient energy.
        floorDbfs += this.#floorAlpha * (dbfs - floorDbfs);
      }
      floorDbfs = Math.max(floorDbfs, NOISE_FLOOR_MIN_DBFS);
    };

    const onFrame = (payload: { frame: AudioFrame }): void => {
      const frame = payload.frame;
      const dbfs = rmsToDbfs(frameRms(frame.samples));
      const voiced = dbfs > floorDbfs + this.#thresholdDb;

      // Never let voiced speech energy pull the floor up while we're already
      // in a speech run — it would chase the speaker and mask the hangover.
      if (!(state === "speaking" && voiced)) {
        updateFloor(dbfs);
      }

      if (state === "silent") {
        if (voiced) {
          if (voicedRun === 0) {
            runStartTimestamp = frame.timestamp;
          }
          voicedRun++;
          if (voicedRun >= this.#activationFrames) {
            state = "speaking";
            speechStartTimestamp = runStartTimestamp;
            unvoicedRun = 0;
            ctx.bus.publish("speech-start", {
              timestamp: speechStartTimestamp,
            });
          }
        } else {
          voicedRun = 0;
        }
        return;
      }

      // state === "speaking"
      if (voiced) {
        unvoicedRun = 0;
        return;
      }
      if (unvoicedRun === 0) {
        firstUnvoicedTimestamp = frame.timestamp;
      }
      unvoicedRun++;
      if (unvoicedRun >= this.#hangoverFrames) {
        state = "silent";
        voicedRun = 0;
        ctx.bus.publish("speech-end", {
          timestamp: firstUnvoicedTimestamp,
          durationMs: firstUnvoicedTimestamp - speechStartTimestamp,
        });
      }
    };

    const unsubscribe = ctx.bus.subscribe("audio-frame", onFrame);
    return {
      dispose: () => {
        unsubscribe();
      },
    };
  }
}

/** Creates a configured {@link EnergyVadStage} factory. */
export function createEnergyVadStage(
  config?: EnergyVadStageConfig
): EnergyVadStage {
  return new EnergyVadStage(config);
}

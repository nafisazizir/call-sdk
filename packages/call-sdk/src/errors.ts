/**
 * Error types for call-sdk.
 *
 * A single base error carrying a stable `code` string and an optional
 * `cause`, with narrow subclasses for each failure category rather than one
 * error type distinguished only by message text.
 */

/** Base error type for all call-sdk errors. */
export class CallSdkError extends Error {
  readonly code: string;
  override readonly cause?: unknown;

  constructor(message: string, code: string, cause?: unknown) {
    super(message);
    this.name = "CallSdkError";
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Thrown for setup-time problems: invalid pipeline graph configuration,
 * missing required config, adapters/stages that don't declare a valid
 * event surface, etc. Callers should be able to catch this specifically to
 * fail fast at startup rather than mid-call.
 */
export class CallConfigError extends CallSdkError {
  constructor(message: string, cause?: unknown) {
    super(message, "CALL_CONFIG_ERROR", cause);
    this.name = "CallConfigError";
  }
}

/**
 * Thrown for adapter-level failures — e.g. a provider connection dropping,
 * or an adapter operation being invoked in an invalid state.
 */
export class AdapterError extends CallSdkError {
  readonly adapterName?: string;

  constructor(
    message: string,
    opts?: { adapterName?: string; cause?: unknown }
  ) {
    super(message, "ADAPTER_ERROR", opts?.cause);
    this.name = "AdapterError";
    this.adapterName = opts?.adapterName;
  }
}

/** Thrown when audio data doesn't match the format it's declared/expected to be in. */
export class AudioFormatError extends CallSdkError {
  constructor(message: string, cause?: unknown) {
    super(message, "AUDIO_FORMAT_ERROR", cause);
    this.name = "AudioFormatError";
  }
}

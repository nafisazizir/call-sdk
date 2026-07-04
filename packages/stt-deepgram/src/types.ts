export interface DeepgramStageConfig {
  /** Deepgram API key. Defaults to `process.env.DEEPGRAM_API_KEY`, read lazily at `attach()`. */
  apiKey?: string;
  /**
   * The Deepgram Listen websocket endpoint.
   * Default `"wss://api.deepgram.com/v1/listen"`. Overridable for tests
   * (point at a fake local server).
   */
  baseUrl?: string;
  /** Endpointing sensitivity (ms of silence), sent as `&endpointing=`. Default 300. */
  endpointingMs?: number;
  /** Transcription language. Default `"en"`. */
  language?: string;
  /** Deepgram model. Default `"nova-3"`. */
  model?: string;
  /** Deepgram's `smart_format` post-processing. Default true. */
  smartFormat?: boolean;
  /** `UtteranceEnd` delay (ms), sent as `&utterance_end_ms=`. Default 1000. */
  utteranceEndMs?: number;
}

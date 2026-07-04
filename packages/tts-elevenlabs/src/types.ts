export interface ElevenLabsStageConfig {
  /** ElevenLabs API key. Defaults to `process.env.ELEVENLABS_API_KEY`, read lazily at `attach()`. */
  apiKey?: string;
  /**
   * The ElevenLabs API base URL. Default `"https://api.elevenlabs.io"`.
   * Overridable for tests (point at a fake local server).
   */
  baseUrl?: string;
  /** ElevenLabs model. Default `"eleven_turbo_v2_5"`. */
  modelId?: string;
  /** ElevenLabs' `optimize_streaming_latency` query param (0-4). Default 3. */
  optimizeStreamingLatency?: number;
  /**
   * Output PCM format. Only `"pcm_16000"` is supported (the canonical
   * sample rate — zero resampling needed downstream), expressed as a union
   * of one so widening to other rates later is additive, not breaking.
   */
  outputFormat?: "pcm_16000";
  /** ElevenLabs voice id. Defaults to `process.env.ELEVENLABS_VOICE_ID`, read lazily at `attach()`. */
  voiceId?: string;
}

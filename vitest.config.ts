import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/call-sdk",
      "packages/adapter-twilio",
      "packages/stt-deepgram",
      "packages/tts-elevenlabs",
      "packages/tests",
      "examples/twilio-on-ws",
    ],
  },
});

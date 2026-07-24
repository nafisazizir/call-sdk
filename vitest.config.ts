import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/call-sdk",
      "packages/adapter-twilio",
      "packages/adapter-telnyx",
      "packages/tests",
      "examples/call-router",
      "examples/twilio-on-ws",
    ],
  },
});

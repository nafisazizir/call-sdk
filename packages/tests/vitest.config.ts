import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./src/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/setup.ts"],
    },
  },
});

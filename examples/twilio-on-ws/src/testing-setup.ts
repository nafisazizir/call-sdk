import { matchers } from "@call-adapter/tests";
import { expect } from "vitest";

// The voice-pipeline tests use the kit's custom matchers (`toBeCanonicalFrame`,
// `toHaveEndedOnce`, `toHaveEmitted`). Register them for this project's Vitest
// run — the kit registers them for its own run, but that setup doesn't reach
// here. Their types are augmented onto `vitest` in `pipeline/testing/matchers.ts`.
expect.extend(matchers);

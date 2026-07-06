import { adapterContract } from "./conformance";
import { createMockAdapter } from "./factories";

adapterContract("mock", () => createMockAdapter());

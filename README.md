# Call SDK

[![MIT License](https://img.shields.io/badge/License-MIT-000?style=flat-square&logo=opensourceinitiative&logoColor=white&labelColor=000&color=000)](LICENSE)

A unified toolkit for building real-time AI voice agents across any telephony or voice provider. Call SDK is the voice-native sibling of Vercel's Chat SDK — where Chat SDK abstracts text chat providers behind a common interface, Call SDK abstracts _voice_ providers (Twilio, WebRTC, WhatsApp calls, and others) behind a consistent set of composable primitives, so a developer writes their agent logic once and runs it on any provider by swapping an adapter.

> **Under construction.** This repository currently holds the monorepo scaffolding described in [SPEC.md](SPEC.md). Core packages are stubs — see the milestones in progress.

## Packages

| Package                       | npm name                    | Role                                                        |
| ------------------------------ | ---------------------------- | ------------------------------------------------------------ |
| `packages/call-sdk`            | `call-sdk`                   | Core SDK — `Call`, `CallSession`, event bus, default stages |
| `packages/adapter-twilio`      | `@call-adapter/twilio`       | Twilio telephony adapter                                    |
| `packages/stt-deepgram`        | `@call-adapter/stt-deepgram`  | Deepgram streaming transcription stage                      |
| `packages/tts-elevenlabs`      | `@call-adapter/tts-elevenlabs`| ElevenLabs speech synthesis stage                           |
| `packages/tests`               | `@call-adapter/tests`        | Shared Vitest conformance suite for adapters and stages      |
| `examples/twilio-on-ws`        | `example-twilio-on-ws`       | Minimal example wiring the Twilio adapter over a WebSocket   |

See [SPEC.md](SPEC.md) for the full design specification.

## License

MIT

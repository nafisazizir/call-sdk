# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` already exists at the repo root (model-selection guidance) — do not create, modify, or symlink it here.

`SPEC.md` (the full design specification and rationale) exists locally in this repo but is **gitignored** — it is not checked in and will not be present in a fresh clone or on GitHub. Docs in this repo (READMEs, this file) must therefore stand alone and never link to `SPEC.md` as if it were a tracked file.

## Commands

```bash
pnpm install
pnpm validate        # knip + check + typecheck + test + build — run before declaring work done
pnpm check           # lint/format (Ultracite/Biome)
pnpm fix             # auto-fix lint/format issues
pnpm typecheck
pnpm test            # all package tests via Turborepo
pnpm test:workspace  # single Vitest run across all package projects
pnpm build
pnpm dev             # watch mode
pnpm knip            # unused exports/dependencies
pnpm konsistent      # adapter/stage package shape (see .github/konsistent.json)

# Per-package
pnpm --filter call-sdk test
pnpm --filter @call-adapter/twilio build
pnpm --filter @call-adapter/stt-deepgram typecheck
pnpm --filter example-twilio-on-ws dev
```

Install dependencies with `pnpm add`, not by editing `package.json` by hand.

## Monorepo layout

pnpm + Turborepo monorepo. Packages are ESM (`"type": "module"`), TypeScript, bundled with **tsup**.

| Path | Role |
| --- | --- |
| `packages/call-sdk` | Core SDK (`call-sdk`): `Call`, `CallSession`, the event bus, event taxonomy, default pipeline wiring, audio primitives |
| `packages/adapter-twilio` | Twilio telephony adapter (`@call-adapter/twilio`) |
| `packages/stt-deepgram` | Deepgram streaming transcription stage (`@call-adapter/stt-deepgram`) |
| `packages/tts-elevenlabs` | ElevenLabs speech synthesis stage (`@call-adapter/tts-elevenlabs`) |
| `packages/tests` | `@call-adapter/tests` — Vitest factories/matchers/conformance suite for adapter and stage authors |
| `examples/*` | Example apps; `package.json` `name` must be `example-*` (private, no changeset) |

When editing a specific package, check for local conventions in its own tests before assuming — there is no per-package AGENTS.md yet in this repo.

## Architecture

### Core concepts

1. **`Call`** (`packages/call-sdk/src/call.ts`) — the configured application: a map of named `adapters`, pipeline `stages`, and lifecycle handlers. Set up once, services many calls. Exposes `webhooks.<adapter>` (fetch-style control plane) and `media.<adapter>` (WebSocket media plane) per configured adapter.
2. **`CallSession`** (`packages/call-sdk/src/session.ts`) — one call in flight: the per-call runtime carrying duplex conversation state (`idle` / `user-speaking` / `agent-speaking`), the session's `EventBus`, `say()`, `transcript`, and `telemetry`. Session ids are `${adapterName}:${callId}`.
3. **`Adapter`** (`packages/call-sdk/src/types.ts`) — one per telephony/voice provider. Does exactly two things: emit call lifecycle events (`webhook`, `media` → `AdapterSessionHandle.answered/end/fail`) and move normalized audio bidirectionally (`AdapterSessionHandle.deliverAudio` in, `OutboundAudio.write`/`clear`/`mark` out). No VAD, transcription, turn detection, or semantic interpretation ever lives in an adapter — even when the underlying provider offers it natively.
4. **`Stage`** (`packages/call-sdk/src/types.ts`) — one per pipeline processing unit (VAD, STT, turn detection, TTS, or custom). Declares `consumes`/`emits` event types (validated at `new Call(...)` setup time, not mid-call), and is instantiated fresh per session via `attach(ctx): StageHandle`, disposed in reverse attach order at teardown.
5. **`EventBus`** (`packages/call-sdk/src/bus.ts`) — a small, synchronous, typed pub/sub bus, one per session. This is the spine of the pipeline: stages are not 1:1 byte transforms (VAD emits signals, STT emits many events per utterance, turn detection emits a decision), so the graph is event-driven, not a chain of `TransformStream`s. Raw audio, byte-edge transforms (format normalization, TTS output), and backpressure are the exception — those live at actual stream/socket boundaries.

### Event taxonomy

The full event map is `CallEventMap` in `packages/call-sdk/src/events.ts` — see the root [README](README.md#event-taxonomy) for the one-line-per-event table. Naming rules when adding new event types: kebab-case; streams are nouns (`audio-frame`); signals are `x-start`/`x-end` pairs; lifecycle events are past-tense facts (`call-started`); `agent-say` is the sole command event (a verb, not a fact) — keep it that way, since it's what makes the fact/command distinction visible at a glance.

### Canonical audio format

PCM16 mono @ 16kHz, 20ms frames (320 samples/frame) — `CANONICAL_FORMAT` in `packages/call-sdk/src/audio/format.ts`. Every adapter normalizes to this on the way in and de-normalizes on the way out; every stage operates on it. This is load-bearing: it's what lets one VAD/STT/turn configuration work identically across every provider. Don't add a second in-pipeline audio format.

### Teardown rules

Exactly one `call-ended` event per call, on every path (`CallSession.#runTeardown`): stop accepting inbound audio → abort in-flight work (resolve any pending `say()` as interrupted) → dispose stages in reverse attach order (each closes its own upstream connection) → flush telemetry → publish `call-ended` → close the bus. Adapter operations (`write`/`clear`/`deliverAudio`) after call end must be safe no-ops (logged, not thrown) — a provider event racing teardown is expected, not a bug. Upstream failures (a stage's provider socket dropping, a handler throwing) surface as a session `error` event; `fatal: true` (the default) ends the call gracefully. v1 does no automatic recovery — no stage restarts, no media-socket reconnection.

## Naming conventions (enforced by konsistent)

Mechanically enforced via `konsistent` (`.github/konsistent.json`) — run `pnpm konsistent` after changing public exports:

- Adapters: `create${Name}Adapter(config)` → `${Name}Adapter` (implements `Adapter`), with a `${Name}AdapterConfig` type exported from `./types`.
- Stages: `create${Name}Stage(config)` → `${Name}Stage` (implements `Stage`), with a `${Name}StageConfig` type exported from `./types`.
- Every `packages/*` directory must contain `README.md`, `package.json`, `tsconfig.json`, `tsup.config.ts`, `src/index.ts` (and `src/types.ts` for adapter/stage packages).

## Testing conventions

- Tests are colocated: `src/foo.ts` → `src/foo.test.ts`, run via Vitest.
- `@call-adapter/tests` (`packages/tests`) is the shared kit for adapter and stage authors: `createMockAdapter`, `createMockSttStage`/`createMockTtsStage`, `adapterContract`/`stageContract` (conformance suites new adapters/stages should run against), `startFakeTwilioCall`/`FakeTwilioCall` (a protocol-accurate fake Twilio client — signs and POSTs the webhook, opens the media socket, streams paced μ-law audio), and matchers (`toHaveEmitted`, `toBeCanonicalFrame`, `toHaveEndedOnce`).
- The example's E2E test (`examples/twilio-on-ws/src/e2e.test.ts`) drives the real Twilio wire protocol end-to-end through `FakeTwilioCall` with only the provider edges mocked (STT/TTS via the test kit's mock stages) — no credentials, no network egress. It's the model for testing a full agent wiring, not just a unit.
- Run `pnpm test` (all packages via Turborepo) or `pnpm test:workspace` (single Vitest run across the workspace) before declaring work done; `pnpm validate` runs the full gate (knip, check, typecheck, test, build).

## Changesets

Behavioral changes to a publishable package (`call-sdk`, `@call-adapter/*`) need a changeset (`pnpm changeset`). Docs-only changes, test-only changes, CI config, and `examples/*` changes do not — CI's changeset check explicitly excludes `.md`-only diffs under `packages/`. Packages are fixed-versioned together (`.changeset/config.json`'s `fixed` group), so a changeset bumping one bumps all of `call-sdk` + `@call-adapter/*` in lockstep.

## Code style

Ultracite (Biome) via `pnpm check` / `pnpm fix` — most issues auto-fix. This repo's `biome.jsonc` extends `ultracite/biome/core` with a few rules turned off: `noEmptyBlockStatements`, `useAwait`, `noSkippedTests`, `noExcessiveCognitiveComplexity`, `noVoid`, `noBarrelFile`, `useNumericSeparators`.

Beyond Biome: prefer `unknown` over `any`; top-level regex literals; `for...of` over `.forEach`; always `await` returned promises; no `console.log`/`debugger` in shipped code; throw descriptive `Error` subclasses (`CallSdkError` and its narrow subclasses in `errors.ts`) rather than plain strings; a `Stage`/`Adapter`'s `dispose`/teardown path must never throw (log and continue).

See `../chat/AGENTS.md` for the reference implementation this repo mirrors (adapter discipline, monorepo conventions, testing patterns) — but note Chat SDK is turn-based request/response messaging, while Call SDK is duplex, stateful, real-time audio; borrow the structure, not the interaction model.

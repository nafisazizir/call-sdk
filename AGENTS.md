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
pnpm --filter example-twilio-on-ws typecheck
pnpm --filter example-call-router dev
```

Install dependencies with `pnpm add`, not by editing `package.json` by hand.

## Monorepo layout

pnpm + Turborepo monorepo. Packages are ESM (`"type": "module"`), TypeScript, bundled with **tsup**.

| Path | Role |
| --- | --- |
| `packages/call-sdk` | **Thin core** (`call-sdk`): `Call`, `CallSession`, call-control routing (`IncomingCall`/`RoutingDecision`), lifecycle events, the normalized audio boundary (`SessionAudio`), event bus, telemetry, audio byte primitives. No semantics. |
| `packages/adapter-twilio` | Twilio telephony adapter (`@call-adapter/twilio`): TwiML verb translation, signature validation, media wire protocol, REST dial |
| `packages/tests` | `@call-adapter/tests` — conformance suites (`adapterContract`, `routingContract`), `createMockAdapter`, `FakeTwilioCall` + `parseTwiml`, matchers. Depends only on `call-sdk`. |
| `examples/*` | Example apps; `package.json` `name` must be `example-*` (private, no changeset). `call-router` = control-plane-only routing; `twilio-on-ws` = the AI voice agent, which **also owns the voice pipeline** (`src/pipeline/**`: `attachVoice`/`VoiceSession`, the `Stage` contract + graph validation, energy-VAD + silence-turn + Deepgram STT + ElevenLabs TTS stages, `say()`/transcript/barge-in policy, turn-latency math, mock STT/TTS stages) |

The voice pipeline (VAD, STT, TTS, turn detection, `attachVoice`) lives in `examples/twilio-on-ws/src/pipeline` as plain source **by design**: it is consumer-layer demo code, not part of the SDK's published surface. It graduates to its own package (`@call-adapter/pipeline` + `stt-*`/`tts-*` stage packages) once the multi-provider abstraction is proven. The SDK's package surface is only `call-sdk`, `@call-adapter/twilio`, and `@call-adapter/tests`.

## Architecture

A call has two planes — a **control plane** (webhook in, routing decision out; runs anywhere) and an opt-in **media plane** (a long-lived WebSocket of normalized duplex audio, only for calls routed to `stream()` or dialed out).

### Core concepts

1. **`Call`** (`packages/call-sdk/src/call.ts`) — the configured application: `new Call({ adapters, logger?, routing?, telemetry? })`. Behavior is registered with **methods**, not config callbacks: `call.onIncomingCall(handler)` (single-slot; throws on a second registration), `call.onCallStarted/onCallAnswered/onCallEnded/onError` (multiple, registration order, late registration works). Outbound is imperative: `call.dial({ adapter, to, from? })` resolves with a live `CallSession` once media flows. Exposes `webhooks.<adapter>` (fetch-style) and `media.<adapter>` (structural `MediaSocket`) per configured adapter.
2. **Call-control routing** (`packages/call-sdk/src/routing.ts`) — `onIncomingCall` receives an `IncomingCall` handle (`from`/`to`/`callId`/`raw`) and returns a decision from its verb methods: `reject` / `forwardTo` / `voicemail` / `say` / `play` / `stream` / `hangup`. Decisions are internally an action list (`voicemail` = say + record) so composition is additive later. No handler → `stream()`. Handler error/timeout (default 5 s, `routing.handlerTimeoutMs`) → `reject`, logged. **Verb-routed calls create no `CallSession`** — sessions and the `call-started`/`call-ended` lifecycle exist exactly for media-plane calls; everything else is fire-and-forget at the webhook (provider status callbacks are out of v1 scope, not precluded).
3. **`CallSession`** (`packages/call-sdk/src/session.ts`) — one media-plane call in flight: the typed `bus`, `audio` (`frames()` in; `write`/`clear`/`mark` out; all post-end-safe), `telemetry`, `signal` (aborts at teardown), `ended`, `registerCleanup()`. Session ids are `${adapterName}:${callId}`. No semantics: `say`/`transcript`/conversation state live in the pipeline.
4. **`Adapter`** (`packages/call-sdk/src/types.ts`) — one per provider. Does exactly **three** things: emit call lifecycle events (`webhook`/`media` → `AdapterSessionHandle.answered/end/fail/mark`), execute call-control instructions (call `ctx.routeIncomingCall(init)` between webhook parse and response, then translate the returned `RoutingDecision` to the provider dialect — pure translation, the adapter decides nothing), and move normalized audio (`deliverAudio` in, `OutboundAudio.write/clear/mark` out). No VAD, transcription, turn detection, or semantic interpretation ever lives in an adapter — even when the provider offers it natively. An action the adapter can't express throws `AdapterError` (webhook → 500), loudly.
5. **The pipeline** (`examples/twilio-on-ws/src/pipeline`, example source) — `attachVoice(session, { stages, interruption?, onEndOfTurn?, ... })` → `VoiceSession` (`say()`, `stopSpeaking()`, `transcript`, `state`, `turns`, own `bus`, `detach()`). Must be called **synchronously** in an `onCallStarted` handler (before the first `await`) so buffered inbound audio replays into the stages. Validates the stage graph synchronously; attaches stages in the background (inbound audio buffered, `say()` queued); registers stage-graph disposal via `session.registerCleanup` so provider connections close before the terminal event. **`Stage`** declares `consumes`/`emits` (validated at attach), is instantiated fresh per session via `attach(ctx): StageHandle`, disposed in reverse attach order.
6. **`EventBus`** (`packages/call-sdk/src/bus.ts`) — small, synchronous, typed pub/sub. Two buses per voice call: the session bus (transport events) and the pipeline bus (`voice.bus`, the stage graph's spine, with transport events forwarded onto it from attach time onward — note `call-started` fires before attach and is only on the session bus).

### Event taxonomy

Core `CallEventMap` (`packages/call-sdk/src/events.ts`) is transport-only: `call-started`, `call-answered`, `call-ended`, `audio-frame`, `audio-mark`, `error`, `telemetry` (runtime list: `CORE_CALL_EVENT_TYPES`). The pipeline **merges** its 12 semantic events into the same interface via `declare module "call-sdk"` (`examples/twilio-on-ws/src/pipeline/events.ts`, runtime list: `PIPELINE_EVENT_TYPES`) — importing anything from the example's pipeline module activates the merge for the whole compilation. Naming rules: kebab-case; streams are nouns (`audio-frame`); signals are `x-start`/`x-end` pairs; lifecycle events are past-tense facts; `agent-say` is the sole command event (a verb, not a fact) — keep it that way.

### Canonical audio format

PCM16 mono @ 16kHz, 20ms frames (320 samples/frame) — `CANONICAL_FORMAT` in `packages/call-sdk/src/audio/format.ts`. Every adapter normalizes to this on the way in and de-normalizes on the way out; every stage operates on it. Load-bearing: one VAD/STT/turn configuration works identically across every provider. Don't add a second in-pipeline audio format.

### Teardown rules

Exactly one `call-ended` event per media-plane call, on every path (`CallSession.#runTeardown`): stop accepting inbound audio → abort (`session.signal`) → run `registerCleanup` functions in reverse registration order (this is where the pipeline disposes its stage graph — provider sockets close **before** the terminal event) → flush telemetry → publish `call-ended` → close the bus. Adapter operations (`write`/`clear`/`deliverAudio`) after call end must be safe no-ops (logged, not thrown). Upstream failures surface as a session `error` event; `fatal: true` (the default for stage/adapter failures) ends the call gracefully. v1 does no automatic recovery — no stage restarts, no media-socket reconnection.

### Twilio adapter specifics

`routingDecisionTwiml` (`packages/adapter-twilio/src/twiml.ts`) translates each `RoutingAction` to TwiML; `<Record>`'s `action` URL is **mandatory** (`?call_sdk_action=hangup` back at the same webhook — without it Twilio re-requests the webhook and re-runs routing, an infinite voicemail loop). The webhook validates the `X-Twilio-Signature` first, then short-circuits `call_sdk_action` continuations to `<Hangup/>` before routing — a mechanical completion of an already-made decision, not a new one. `stream` uses `connectStreamTwiml` (`<Connect><Stream>`); attribute escaping (`escapeXmlAttr`) and text-content escaping (`escapeXmlText`) are distinct.

## Naming conventions (enforced by konsistent)

Mechanically enforced via `konsistent` (`.github/konsistent.json`) — run `pnpm konsistent` after changing public exports:

- Adapters: `create${Name}Adapter(config)` → `${Name}Adapter` (implements `Adapter` from `call-sdk`), with a `${Name}AdapterConfig` type exported from `./types`. This is the only konsistent-enforced package shape now that the stage packages have moved into the example.
- Stages (example convention, no longer konsistent-enforced): `create${Name}Stage(config)` → `${Name}Stage` implements `Stage` from the example's pipeline module — see `examples/twilio-on-ws/src/pipeline/stages/`. Keep the shape so a stage can later graduate to a package unchanged.
- Every `packages/*` directory must contain `README.md`, `package.json`, `tsconfig.json`, `tsup.config.ts`, `src/index.ts` (and `src/types.ts` for adapter packages).

## Testing conventions

- Tests are colocated: `src/foo.ts` → `src/foo.test.ts`, run via Vitest.
- `@call-adapter/tests` (`packages/tests`) is the shared kit: `createMockAdapter`, `adapterContract` (transport/lifecycle conformance), `routingContract` (per-verb translation conformance — instantiate it for every new adapter), `startFakeTwilioCall`/`FakeTwilioCall` (protocol-accurate fake Twilio client — signs and POSTs the webhook, opens the media socket or returns a control-plane-only stub with the parsed TwiML, streams paced μ-law audio), `parseTwiml`, and matchers (`toHaveEmitted`, `toBeCanonicalFrame`, `toHaveEndedOnce`, `recordEvents`, which defaults to the core taxonomy and accepts an extended event list). Dependency direction: **kit → call-sdk only** — the kit knows nothing about the voice pipeline.
- The `stageContract` conformance suite and the mock STT/TTS stages live with the pipeline they test, in `examples/twilio-on-ws/src/pipeline/testing/`. That module also wraps the kit's `recordEvents` with the full pipeline taxonomy (`ALL_CALL_EVENT_TYPES`).
- The examples' E2E tests (`examples/*/src/e2e.test.ts`) drive the real Twilio wire protocol through `FakeTwilioCall` with zero credentials — `call-router` asserts returned TwiML per routing branch (including the `<Record action>` continuation); `twilio-on-ws` drives the full voice loop (happy path, barge-in, exactly-once teardown, signature rejection). They are the model for testing an app wiring, not just a unit.
- Run `pnpm validate` (the full gate) before declaring work done.

## Changesets

Behavioral changes to a publishable package (`call-sdk`, `@call-adapter/*`) need a changeset (`pnpm changeset`). Docs-only changes, test-only changes, CI config, and `examples/*` changes do not. Packages are fixed-versioned together (`.changeset/config.json`'s `fixed` group covers `call-sdk` + `@call-adapter/*` — currently `@call-adapter/twilio` and `@call-adapter/tests`), so a changeset bumping one bumps all in lockstep.

## Code style

Ultracite (Biome) via `pnpm check` / `pnpm fix` — most issues auto-fix. This repo's `biome.jsonc` extends `ultracite/biome/core` with a few rules turned off: `noEmptyBlockStatements`, `useAwait`, `noSkippedTests`, `noExcessiveCognitiveComplexity`, `noVoid`, `noBarrelFile`, `useNumericSeparators`.

Beyond Biome: prefer `unknown` over `any`; top-level regex literals; `for...of` over `.forEach`; always `await` returned promises; no `console.log`/`debugger` in shipped code; throw descriptive `Error` subclasses (`CallSdkError` and its narrow subclasses in `call-sdk`'s `errors.ts`, `StageError` in the pipeline) rather than plain strings; an `Adapter`/`Stage` dispose/teardown path must never throw (log and continue); conditional-spread optional fields (`exactOptionalPropertyTypes` is on).

See `../chat/AGENTS.md` for the reference implementation this repo mirrors (adapter discipline, monorepo conventions, testing patterns) — but note Chat SDK is turn-based request/response messaging, while Call SDK has a control plane plus duplex, stateful, real-time audio; borrow the structure, not the interaction model.

# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` already exists at the repo root (model-selection guidance) and must remain untouched — do not create a `CLAUDE.md` symlink here.

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
```

Install dependencies with `pnpm add`, not by editing `package.json` by hand.

## Monorepo layout

pnpm + Turborepo monorepo. Packages are ESM (`"type": "module"`), TypeScript, bundled with **tsup**.

| Path                        | Role                                                                  |
| ---------------------------- | ---------------------------------------------------------------------|
| `packages/call-sdk`          | Core SDK (`call-sdk`): `Call`, `CallSession`, event bus, default pipeline wiring |
| `packages/adapter-twilio`    | Twilio telephony adapter (`@call-adapter/twilio`)                     |
| `packages/stt-deepgram`      | Deepgram streaming transcription stage (`@call-adapter/stt-deepgram`) |
| `packages/tts-elevenlabs`    | ElevenLabs speech synthesis stage (`@call-adapter/tts-elevenlabs`)    |
| `packages/tests`             | `@call-adapter/tests` — Vitest factories/matchers for adapter and stage conformance tests |
| `examples/*`                 | Example apps; `package.json` `name` must be `example-*` (private, no changeset) |

## Conventions

- Install deps via `pnpm add`, never hand-edit `package.json` dependency blocks.
- ESM only (`"type": "module"`), built with **tsup** (`esm`, `dts`, `clean`).
- Behavioral package changes need a changeset (`pnpm changeset`). Docs-only, tests-only, CI, and `examples/*` changes do not.
- Naming is enforced mechanically via `konsistent` (`.github/konsistent.json`), mirroring Chat SDK:
  - Adapters: `create${Name}Adapter(config)` → `${Name}Adapter` (implements `Adapter`), with `${Name}AdapterConfig`.
  - Stages: `create${Name}Stage(config)` → `${Name}Stage` (implements `Stage`), with `${Name}StageConfig`.
  - Every `packages/*` directory must contain `README.md`, `package.json`, `tsconfig.json`, `tsup.config.ts`, `src/index.ts`.
  - Run `pnpm konsistent` after changing public exports.

See [SPEC.md](SPEC.md) for the full design specification and rationale, and `../chat` for the reference implementation this repo mirrors.

# Voice Agent SDK Roadmap

## Status

This document records the current product direction and an evidence-driven roadmap. It is not a commitment to a package name or public API. Both should remain experimental until the portability claims have been proven.

## Decision summary

- **Call SDK remains a standalone, semantics-free telephony transport.** It owns provider-neutral call control, call lifecycle, normalized duplex audio, and transport capabilities. It will not own VAD, STT, turn detection, LLM orchestration, TTS, tools, transcripts, or conversation state.
- **Voice is a separate SDK layered above transport.** It owns real-time conversation orchestration: turns, interruption, cancellation, STT/agent/TTS coordination, speech scheduling, conversation state, and per-turn observability.
- **Develop Call and Voice in parallel.** Call SDK enters stabilization mode while Voice enters discovery mode. Voice is the consumer that will reveal whether Call SDK's transport boundary is sufficient.
- **Keep strict dependency direction.** Voice semantics never move down into Call SDK. A bridge package may depend on both.
- **Start as an SDK, not a framework.** Deployment conventions, workers, persistence, dashboards, and project structure should only become a framework after several real applications repeatedly need the same assembly.
- **Compete on focus, not feature count.** The target is a small TypeScript- and AI SDK-native path from a reusable agent to a real phone call, without requiring a hosted voice-agent service or RTC platform.

## Product thesis

> Connect an AI SDK agent to any real-time audio transport, including direct telephone calls, without adopting a hosted voice-agent platform or RTC infrastructure.

The portable unit is the agent's intelligence:

- instructions and behavior
- model or AI SDK agent
- tools and authorization
- business logic
- conversation-state policy

Delivery runtimes remain responsible for modality-specific behavior. Voice requires turn-taking, interruption, playback accounting, and latency policy; chat requires threads, messages, cards, and reactions. The goal is **one agent brain across multiple delivery runtimes**, not identical presentation on every channel.

## Market and OSS landscape

The broad category already exists. The purpose of studying existing systems is to derive requirements and avoid known mistakes, not to combine every feature into a new framework.

### LiveKit Agents

LiveKit Agents is the strongest TypeScript benchmark for a complete voice-agent framework. It already provides cascaded and native realtime models, turn detection, interruption, tools, handoffs, testing, observability, and deployment.

Adopt as design lessons:

- separate reusable `Agent` behavior from per-conversation `AgentSession`
- explicit listening, thinking, and speaking states
- interruptible speech handles and priority-aware speech scheduling
- separate cascaded, realtime, and half-cascade execution modes
- stateless agents with session-specific user data
- text-mode agent tests that do not require real audio
- narrow extension nodes around STT, LLM, TTS, and transcription

Avoid importing into the architecture:

- a required room, participant, or track model
- tight coupling between transport disconnect and conversation lifecycle
- agent-server and job-dispatch infrastructure in the SDK
- a large plugin hierarchy before extension requirements are proven

References:

- [LiveKit Agent sessions](https://docs.livekit.io/agents/logic/sessions/)
- [LiveKit pipeline types](https://docs.livekit.io/agents/models/pipelines/)
- [LiveKit turn handling](https://docs.livekit.io/agents/logic/turns/)
- [LiveKit testing](https://docs.livekit.io/agents/start/testing/)

### Pipecat

Pipecat is the strongest benchmark for a transport-neutral voice pipeline and direct telephony integration.

Adopt as design lessons:

- explicit transport input/output boundaries
- high-priority interruption and lifecycle control that bypass ordinary data queues
- cancellation propagated through generation, synthesis, and transport playout
- provider-neutral conversation context translated only at provider boundaries
- per-stage latency and usage measurements
- deterministic text tests plus end-to-end audio evaluations

Avoid initially:

- a universal frame graph for every kind of data and control
- a large hierarchy of frame processors
- complex queue recreation and custom task-management machinery
- runtime updates for every configuration property
- multimodal and multi-worker scope

References:

- [Pipecat pipeline architecture](https://docs.pipecat.ai/pipecat/learn/pipeline)
- [Pipecat transports](https://docs.pipecat.ai/pipecat/learn/transports)
- [Pipecat frame categories](https://docs.pipecat.ai/api-reference/server/frames/overview)
- [Pipecat interruption semantics](https://docs.pipecat.ai/pipecat/fundamentals/interruptions)

### Vapi

Vapi is a product and API benchmark rather than an implementation source.

Adopt as product lessons:

- the immediately understandable Transcriber / Model / Voice configuration model
- reusable configuration with per-call overrides
- a short path to the first working phone call
- spoken progress messages around slow tool execution
- call artifacts such as transcripts, recordings, logs, and latency traces
- evals, simulated conversations, tool mocks, and CI quality gates
- context-aware agent handoffs as a later capability

Avoid initially:

- dashboard resource IDs as the primary programming model
- a large nested JSON configuration surface
- hosted control-plane assumptions
- squads, campaigns, and visual workflows

References:

- [Vapi documentation](https://docs.vapi.ai/)
- [Vapi evals](https://docs.vapi.ai/observability/evals-quickstart)

### ElevenLabs Agents

ElevenLabs Agents is a benchmark for voice quality, polished conversation controls, testing, and operations.

Adopt as product lessons:

- explicit first-message behavior
- voice and interruption controls with progressive disclosure
- immediate, post-speech, and asynchronous tool execution modes
- next-reply, tool-call, and full-conversation test categories
- turning failed production conversations into regression tests
- versioning, experiments, and granular conversation analytics as long-term product ideas

Avoid initially:

- coupling the runtime to one speech provider
- visual workflow graphs
- hosted agent configuration as the primary API

References:

- [ElevenLabs Agents overview](https://elevenlabs.io/docs/eleven-agents/overview.md)
- [ElevenLabs agent testing](https://elevenlabs.io/docs/eleven-agents/customization/agent-testing.mdx)

## Licensing and implementation policy

Benchmark behavior and architecture before implementation. Record the user problem, competitor behavior, our decision, and the test that will prove it.

- LiveKit Agents is Apache-2.0.
- Pipecat is BSD-2-Clause.
- Hosted product behavior does not imply access to implementation code.

Prefer independent implementation from behavioral specifications. If source is copied or adapted, record its origin and preserve all required license notices. Do not silently relicense copied code as MIT.

## Architecture

```text
                         Agent definition
                 instructions + model + tools
                              |
                     Voice Agent Runtime
       turns + interruption + STT/agent/TTS + state
                              |
                    Voice Transport Session
             input audio + output audio + lifecycle
                    /                       \
          Call SDK bridge              future transports
             /       \
          Twilio     Telnyx
```

A likely package direction is:

```text
call-sdk                    # telephony core; no voice dependency
@call-adapter/twilio        # direct provider adapter
@call-adapter/telnyx        # direct provider adapter

voice-agent                 # transport-independent conversation runtime
@voice-transport/call       # bridge between Voice and CallSession
@voice-agent/tests          # fake providers and conformance suites
```

Names are placeholders. The dependency direction is the decision:

```text
voice-agent                 -> must not require call-sdk
@voice-transport/call       -> voice-agent + call-sdk
call-sdk                    -> must not know voice-agent exists
```

The voice transport should remain a small structural contract around:

- stable session identity
- canonical inbound audio
- outbound write and clear
- optional playback acknowledgement
- abort/close lifecycle
- transport capabilities

## Ownership boundary

### Call SDK owns

- inbound webhook verification and parsing
- provider-neutral call routing decisions
- provider call-control translation
- inbound and outbound call establishment
- normalized audio and media clock
- outbound audio write and queue clear
- provider playback marks when supported
- call lifecycle, termination, and safe post-end behavior
- transport-level telemetry and provider escape hatches

### Voice SDK owns

- VAD and speech activity
- STT and transcript lifecycle
- end-of-turn policy
- AI SDK agent/model invocation
- tools and tool-execution speech policy
- streaming text segmentation
- TTS and audio generation
- speech scheduling and priorities
- interruption and cancellation policy
- playback-duration fallback when transport marks are unavailable
- conversation history and commit policy
- user/agent state and semantic events
- per-turn latency and usage telemetry

### Boundary test

Before adding anything to Call SDK, ask:

> Would this concept make sense to a recorder, call router, or human-assisted call application with no AI?

If not, it belongs above Call SDK.

## Parallel development rules

1. **Voice semantics never enter Call SDK.** No transcripts, turns, agent states, LLMs, TTS, or tools in transport core.
2. **Voice may expose missing transport facts.** Valid feedback includes capabilities, playback acknowledgements, audio timing, backpressure, DTMF, and termination behavior.
3. **Do not add speculative transport features.** Require a working consumer, a non-AI use case, support from multiple adapters, or an explicit capability model.
4. **Every transport change must preserve both reference adapters.** Run shared contracts and provider integration tests for Twilio and Telnyx.
5. **Keep provider-specific behavior at the edge.** Do not weaken the common contract merely to expose one provider's managed semantics.
6. **Keep Voice experimental until two-dimensional portability is proven.** One transport and one STT/TTS combination proves a demo, not an abstraction.

## Roadmap

The stages below are evidence gates, not dates.

### Stage 0: product and architecture benchmark

Deliverables:

- product thesis and explicit non-goals
- competitor capability matrix
- one north-star application
- initial package and dependency diagram
- behavioral decisions for turns, interruptions, tools, playback, and teardown

Exit criterion:

- The project can explain why its target user would choose it over LiveKit: they already have a TypeScript application and AI SDK agent and want direct, provider-portable telephony without a hosted agent or RTC platform.

### Stage 1A: stabilize Call SDK transport

Run in parallel with Stage 1B.

Work:

- validate real Twilio inbound and outbound calls
- validate real Telnyx inbound and outbound calls
- exercise hangup, queue clear, playback marks, and disconnects against real providers
- add a runnable media-plane example
- strengthen adapter conformance around canonical audio, ordering, clear, marks, and socket failure
- test long-running and concurrent sessions
- resolve documentation and capability inconsistencies

Defer:

- more telephony adapters
- DTMF and IVR expansion
- recording retrieval
- provider status callbacks
- browser and WebRTC transports
- new routing verbs without a proven application requirement

Exit criterion:

- The same raw duplex application works over real Twilio and Telnyx with only the configured adapter changing.

### Stage 1B: fake-first Voice kernel

Start as an unpublished experimental package.

Initial capabilities:

- a `VoiceSession` orchestrator
- a small voice transport contract
- streaming transcriber contract
- AI SDK agent runner integration
- streaming synthesizer contract
- turn-detector contract
- explicit session, user, and agent states
- an interruptible speech handle

Avoid a generic pipeline DAG initially. The runtime should explicitly orchestrate the critical voice path until real extension requirements emerge.

Build deterministic fakes for transport, STT, agent generation, tools, TTS, and timing. Tests must prove:

1. Input audio can produce a final transcript.
2. A final user turn invokes the agent.
3. Agent text streams into synthesis.
4. Synthesized audio reaches transport output.
5. User speech interrupts generation and immediately clears transport playout.
6. Tool calls execute and their results reach the conversation.
7. Transport teardown aborts every attached resource.
8. Completion and cleanup happen exactly once.

Exit criterion:

- The complete conversational lifecycle is deterministic in Vitest with no credentials or network access.

### Stage 2: first real vertical slice

Build one useful order-status phone agent:

1. The agent greets the caller.
2. The caller asks about an order.
3. The agent collects an order number.
4. An AI SDK tool looks up deterministic order data.
5. The response streams to speech.
6. The caller interrupts while the agent is speaking.
7. Playout stops immediately and the conversation continues.
8. Either participant can end the call cleanly.

Use one stack only:

```text
Transport: Twilio through Call SDK
STT:       one genuinely streaming provider with endpointing
Agent:     Vercel AI SDK with one tool
TTS:       one genuinely streaming provider
```

Prefer provider endpointing or a simple speech-start detector before building semantic turn detection.

Instrument from the beginning:

- user speech start and end
- partial and final transcript
- first model token
- first synthesized audio
- first transport write
- playback completion
- interruption-to-clear latency

Exit criterion:

- The north-star scenario completes over a real phone call, including a real interruption, and a trace shows every stage boundary.

### Stage 3: prove portability

Prove transport portability:

- run the unchanged voice agent over Telnyx

Prove model portability:

- add a second streaming STT provider
- add a second streaming TTS provider

Add conformance suites for:

- voice transports
- streaming transcribers
- streaming synthesizers
- turn detectors

Exit criterion:

- Twilio/Telnyx and STT/TTS providers can be swapped through construction or configuration without changing conversation orchestration or business logic.

### Stage 4: production conversation semantics

Specify and harden:

- what an interruption cancels and what survives
- whether active tool calls are canceled
- how queued speech is discarded
- whether generated, synthesized, or actually played assistant text enters history
- recovery from false interruption
- priority and uninterruptible speech
- `say()` completion semantics
- STT/TTS reconnect and fallback policy
- timeout, recoverable error, and fatal error behavior
- backpressure and bounded queues
- long-call, concurrent-call, and resource-leak behavior

Add OpenTelemetry-compatible spans:

```text
voice.session
  voice.turn
    stt
    turn-detection
    agent-generation
      tool-call
    tts
    transport-playout
```

Exit criterion:

- Every failure mode has an explicit outcome, and stress tests do not leak sessions, listeners, sockets, queues, or background work.

### Stage 5: testing and evaluations

Provide three layers:

1. **Deterministic component tests** for transport, STT/TTS events, cancellation, and state transitions.
2. **Text conversation tests** for messages, tools, arguments, handoffs, and policies without audio.
3. **Simulated conversation tests** with user goals, personas, mocked tools, transcripts, and optional judges.

Add real audio end-to-end tests only after deterministic semantics are trustworthy. Every production failure should be eligible to become a checked-in regression scenario.

Exit criterion:

- Core behavior, business outcomes, and representative end-to-end calls can all be regression-tested independently.

### Stage 6: native realtime models

Add native speech-to-speech as a separate engine:

```ts
new VoiceRuntime({
  engine: cascade({ transcriber, agent, synthesizer }),
});

new VoiceRuntime({
  engine: realtime({ model }),
});
```

Share transport, session lifecycle, events, tools where supported, and telemetry. Do not pretend the engines share transcript timing, exact scripted speech, auditability, turn ownership, or provider-swapping behavior.

Exit criterion:

- Both engines expose a consistent lifecycle while truthfully reporting their different capabilities.

### Stage 7: public API and release preparation

Only after transport and speech-provider portability have validated the contracts:

- review and reduce every public type and configuration field
- write one excellent quickstart
- document lifecycle, interruption, and provider-extension semantics
- publish conformance guidance
- provide real inbound and outbound examples
- test downstream package installation and built artifacts
- deliberately choose initial versions and release process

The repository's pre-v1 release policy remains in force. No changesets, version bumps, packaging housekeeping, or publishing should happen as a side effect of this roadmap.

### Stage 8: decide whether a framework is earned

Consider a framework only after several applications repeatedly need the same:

- project layout
- environment and secrets loading
- worker lifecycle and deployment
- persistent conversation state
- eval execution and promotion
- local development server
- observability backend or trace viewer

Until then, keep the system a host-agnostic SDK.

## Immediate next actions

1. Freeze speculative Call SDK scope expansion; stabilize Twilio, Telnyx, media contracts, examples, and real-call validation.
2. Maintain a competitor capability matrix with columns for user problem, observed behavior, our decision, roadmap phase, and proving test.
3. Write acceptance scenarios for the order-status north-star agent.
4. Sketch the smallest desirable public usage API before finalizing internal interfaces.
5. Start an unpublished experimental Voice package and example.
6. Implement the Voice kernel with deterministic fakes first.
7. Connect it to real Twilio through Call SDK and let the consumer reveal missing transport facts.
8. Connect the unchanged application to Telnyx.
9. Add a second STT and TTS provider to validate model portability.
10. Only then deepen turn policy, reliability, evaluations, realtime models, and framework ergonomics.

## Features explicitly deferred from the first vertical slice

- semantic or adaptive turn-detection models
- native speech-to-speech models
- multiple agents, squads, and handoffs
- workflow graphs and visual builders
- provider failover and health probing
- browser, mobile, WebRTC, video, and avatars
- campaigns, schedules, and bulk outbound calling
- dashboards, hosted configuration, and control planes
- durable workflow execution
- automatic deployment and scaling

## Definition of success

The first meaningful product proof is not a large provider list. It is one application demonstrating both dimensions of portability:

```text
one AI SDK agent
  x two telephony transports
  x two streaming STT providers
  x two streaming TTS providers
```

The business logic, tools, and conversation orchestration remain unchanged across those combinations. Interruption is prompt, teardown is deterministic, and each turn is observable and testable.

The focused product promise is:

> The cleanest TypeScript path from an AI SDK agent to a real phone call, with direct provider portability and no required hosted voice or RTC platform.

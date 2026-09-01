# Stage 0: Product and Architecture Benchmark

## Status

**Gate: passed for Stage 1 discovery and implementation.**

Passing this gate means the planning deliverables and evidence criteria exist; it does not mean the Voice packages or their proving tests have already been implemented. Stage 0 establishes a product thesis, a constrained initial application, an architectural boundary, and testable behavioral hypotheses. It does not freeze package names or public APIs. Those remain experimental until transport and speech-provider portability are demonstrated.

This is a living decision record. New evidence may revise a decision, but Stage 1 work should not expand the product scope without recording the evidence here or in the roadmap.

## Product thesis

> Provide the cleanest TypeScript path to building a real-time voice agent for telephone calls, with AI SDK-native models and tools, direct telephony-provider portability, and no required hosted voice-agent platform or RTC infrastructure.

The target user is a TypeScript developer building a code-first voice application. They may already use AI SDK, but they do not need to arrive with a reusable agent or existing agent architecture. The SDK should support both adapting existing model-and-tool code and starting a voice agent from scratch.

The user needs:

- direct inbound and outbound telephone calls;
- familiar TypeScript composition for models, tools, and application logic;
- real-time turn-taking and interruption;
- provider-neutral telephony and speech boundaries;
- deterministic local tests; and
- enough observability to explain conversation latency and failure.

The product is not trying to win on provider count or feature count. It wins if a TypeScript developer can understand, test, and own the complete path from telephone audio to agent behavior without first adopting rooms, tracks, hosted agent configuration, or a visual workflow system.

## AI SDK strategy

This project bets on AI SDK as the preferred TypeScript ecosystem for models and tools. It is **AI SDK-first, not AI SDK-only**.

- AI SDK is the default integration for model generation, tool definitions, tool execution flow, and message-compatible application state.
- AI SDK speech, transcription, and realtime APIs should become the default implementations whenever they satisfy the Voice runtime's capability and conformance requirements.
- The Voice runtime owns the real-time conversation contract: streaming, endpointing, turn state, interruption, cancellation, speech scheduling, playout accounting, teardown, and per-turn observability.
- Experimental or incomplete upstream APIs stay behind adapters rather than defining permanent Voice public types.
- Direct provider integrations remain valid gap-fillers and advanced escape hatches when AI SDK cannot represent required behavior or provider capabilities.
- Provider-specific options and raw metadata should remain reachable without leaking into portable orchestration.
- When an AI SDK path reaches behavioral parity, it is preferred as the default; existing direct paths should not disappear until users retain equivalent capability and control.

AI SDK preference never justifies weaker interruption, streaming, cancellation, latency, or playback semantics. Adoption is capability-driven: an AI SDK implementation must pass the same conformance suite as a direct implementation.

The durable product value is not temporary access to speech APIs that AI SDK may later add. It is telephone transport, conversation orchestration, interruption correctness, truthful playout state, deterministic testing, portability, and observability. Better AI SDK support should improve this product rather than make it unnecessary.

## Why this instead of LiveKit Agents?

LiveKit Agents is the benchmark for a complete voice-agent framework and is the right choice when a developer wants its RTC platform, room model, deployment model, and mature voice framework.

This project is for the narrower case where the developer:

1. wants to build a code-first voice agent in a TypeScript application;
2. prefers AI SDK-native models and tools without making an existing AI SDK agent a prerequisite;
3. wants to connect directly to telephony providers such as Twilio or Telnyx;
4. does not need an RTC room or participant abstraction;
5. does not want hosted voice-agent configuration to become the source of truth; and
6. wants transport, STT, TTS, tools, and application behavior to remain replaceable code-level dependencies.

The differentiator is therefore **AI SDK-native voice orchestration with direct, provider-portable telephony**, not a broader or more mature feature set than LiveKit.

## Explicit non-goals

The first product proof does not include:

- a hosted control plane or dashboard;
- an agent server, worker scheduler, or deployment framework;
- browser, mobile, WebRTC, video, rooms, participants, or tracks;
- native speech-to-speech models;
- semantic or adaptive turn detection;
- multiple agents, handoffs, squads, campaigns, or visual workflows;
- provider failover or automatic health probing;
- durable workflow execution or persistent conversation infrastructure;
- call recording retrieval or a transcript artifact service;
- every telephony, STT, or TTS provider;
- runtime mutability for every configuration field; or
- a generic multimodal frame graph or pipeline DAG.

Call SDK also remains semantics-free. VAD, STT, turns, LLM orchestration, tools, TTS, transcripts, and conversation state must not move into it.

## Target user and primary job

### Target user

A TypeScript developer building a code-first voice application who wants AI SDK-native model and tool ergonomics while owning the conversation runtime and avoiding direct integration with every telephony provider's media protocol.

### Primary job to be done

> When I build a voice agent in TypeScript, help me compose models, tools, real-time speech, and direct telephone calls with responsive interruption, deterministic tests, and replaceable providers, without requiring a hosted voice-agent or RTC platform.

### Definition of the first meaningful proof

One unchanged application using AI SDK models and tools must run across:

```text
one application and agent behavior
  x two telephony transports
  x two streaming STT providers
  x two streaming TTS providers
```

Its instructions, tools, business logic, and conversation orchestration must not change across those combinations.

## North-star application

The north-star application is an **order-status telephone agent**.

It is deliberately small but exercises the hard parts of a real voice runtime:

1. The agent greets the caller.
2. The caller asks about an order.
3. The agent collects an order number.
4. An AI SDK tool retrieves deterministic order data.
5. The response streams through synthesis to the telephone.
6. The caller interrupts while the agent is speaking.
7. Queued playout stops promptly and the conversation continues coherently.
8. Either participant can end the call cleanly.
9. A trace explains every significant latency boundary and terminal outcome.

### Initial vertical-slice stack

```text
Transport: Twilio through Call SDK
STT:       one genuinely streaming provider with endpointing
Agent:     Vercel AI SDK with one deterministic order-status tool
TTS:       one genuinely streaming provider
```

The first vertical slice proves a useful call, not portability. Portability is proven afterward by running the unchanged application through Telnyx and through second STT and TTS implementations.

## North-star acceptance scenarios

### A1. Greeting reaches the caller

**Given** a caller is connected to the order-status agent  
**When** the voice session becomes ready  
**Then** the agent produces its configured greeting  
**And** synthesized audio is written to the transport  
**And** greeting completion reflects transport playout rather than generation completion alone.

### A2. Caller speech becomes one user turn

**Given** the session is listening  
**When** the caller asks for an order status  
**Then** partial transcripts may be exposed for observation  
**But** partial transcripts do not invoke the agent or enter committed conversation history  
**And** one final transcript creates one committed user turn.

### A3. Missing order number is collected conversationally

**Given** the caller asks for an order status without an order number  
**When** the agent processes the user turn  
**Then** it asks for the missing order number  
**And** the next final caller turn continues the same conversation.

### A4. The order lookup tool is executed

**Given** the conversation contains a valid order number  
**When** the agent requests the order-status tool  
**Then** the tool receives the expected validated argument  
**And** deterministic order data is returned to the agent  
**And** one logical tool request is not accidentally executed twice.

### A5. Agent text streams into speech

**Given** the order tool has returned successfully  
**When** the agent streams its response  
**Then** speakable text is incrementally segmented and sent to synthesis  
**And** synthesized audio begins reaching the transport before the complete response is generated.

### A6. Caller interruption clears playout

**Given** interruptible agent speech is playing  
**When** caller speech is detected  
**Then** active agent generation for that response is canceled  
**And** queued synthesis work for that response is canceled  
**And** transport playout is cleared immediately  
**And** stale audio from that response is not written after the clear  
**And** the caller's new speech can become the next user turn.

### A7. Interruption preserves truthful conversation state

**Given** an agent response is interrupted after only part of it is played  
**When** the next agent turn begins  
**Then** the runtime distinguishes generated, synthesized, queued, and played output  
**And** it does not represent the unplayed remainder as something the caller definitely heard.

### A8. Tool failure remains conversational

**Given** the order tool returns a controlled failure  
**When** the agent receives the tool result  
**Then** the session remains active  
**And** the agent can ask the caller to retry or explain that the order cannot be found  
**And** the failure is visible in the turn trace.

### A9. Caller or application termination cleans up once

**Given** any active voice-session state  
**When** the caller disconnects or the application ends the session  
**Then** the session abort signal fires  
**And** STT, agent generation, tools, TTS, timers, and transport work are stopped or detached  
**And** cleanup runs exactly once  
**And** one terminal session event is produced.

### A10. A trace explains the turn

**Given** a completed or interrupted turn  
**When** its trace is inspected  
**Then** it shows user speech start and end, partial and final transcript timing, first model token, first synthesized audio, first transport write, playback completion when available, and interruption-to-clear latency when applicable.

### A11. Deterministic execution requires no network

**Given** fake transport, STT, agent, tool, TTS, and clock implementations  
**When** the complete north-star conversation is run in Vitest  
**Then** all state changes, outputs, cancellation, and cleanup are deterministic  
**And** no credentials or network access are required.

### A12. Portability does not alter business logic

**Given** the north-star application has passed on the first provider stack  
**When** Twilio is replaced by Telnyx or an STT/TTS provider is replaced through construction  
**Then** agent instructions, order tools, conversation policy, and orchestration source remain unchanged  
**And** provider differences remain behind capability-aware boundaries.

A1-A11 define the functional application. A12 is the later portability proof and is not required to begin Stage 1.

## Architecture decision

A call has two separately owned layers:

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

Proposed package direction:

```text
call-sdk                    # existing semantics-free telephony core
@call-adapter/twilio        # existing Twilio control and media translation
@call-adapter/telnyx        # existing Telnyx control and media translation

voice-agent                 # proposed transport-independent conversation runtime
@voice-transport/call       # proposed VoiceSession-to-CallSession bridge
@voice-agent/tests          # proposed deterministic fakes and conformance suites
```

The Voice package names are placeholders and none is required to exist for Stage 0 to pass. The dependency direction is fixed:

```text
voice-agent                 -> must not require call-sdk
@voice-transport/call       -> may require voice-agent + call-sdk
call-sdk                    -> must not know voice-agent exists
```

### Ownership boundary

Here, **Call transport layer** means the `call-sdk` core together with its provider adapters. The thin core and adapters retain separate responsibilities inside that layer.

#### Call transport layer owns

- provider webhook verification and provider-dialect translation in adapters;
- provider-neutral routing, media-session coordination, and canonical audio contracts in `call-sdk`;
- inbound and outbound call establishment across core and adapters;
- normalized duplex audio and transport timing;
- outbound writes, queue clearing, and provider playback marks;
- media-session lifecycle and termination;
- safe operations after call end;
- transport capabilities and provider escape hatches; and
- transport-level telemetry.

#### Voice runtime owns

- VAD and speech activity;
- STT and transcript lifecycle;
- endpointing and end-of-turn policy;
- agent/model invocation;
- tools and tool-speech policy;
- streaming text segmentation;
- TTS and generated audio;
- speech scheduling and priorities;
- interruption and cancellation policy;
- conversation history and semantic events;
- playback-duration fallback where acknowledgements are unavailable; and
- per-turn latency and usage telemetry.

#### Boundary test

Before adding a concept to Call SDK, ask:

> Would this concept make sense to a recorder, call router, or human-assisted call application with no AI?

If not, it belongs above Call SDK.

### Architectural acceptance checks

These checks protect the boundary while Stages 1A and 1B proceed in parallel:

1. **Semantics-free core:** `call-sdk` exports no VAD, STT, TTS, transcript, turn, LLM, tool, or conversation-state concepts.
2. **Control/media separation:** control-plane routing verbs remain fire-and-forget and create no `CallSession`; only `stream()` and `dial()` create media-plane sessions.
3. **Canonical audio:** every call adapter normalizes inbound audio to PCM16 mono at 16 kHz in 20 ms frames and converts outbound canonical audio to the provider format.
4. **Transport teardown:** Call SDK preserves its exact terminal ordering: stop inbound audio, abort, run cleanup in reverse registration order, flush telemetry, publish one `call-ended`, then close the bus. Post-end adapter operations remain safe no-ops.
5. **Bridge teardown:** ending either an attached `VoiceSession` or `CallSession` settles the bridge once without weakening Call SDK's teardown guarantees.
6. **Stage 1A portability:** the same raw duplex application works over real Twilio and Telnyx with only adapter construction changing.
7. **No speculative transport growth:** a Voice requirement moves into the transport layer only when it is a transport fact and has a non-AI use case, multi-adapter support, a working consumer, or an explicit capability model.

These are constraints and later proving tests, not claims that Stage 1 evidence already exists.

## Initial behavioral decisions

These decisions are sufficient to build and test the fake-first kernel. Stage 4 may harden or revise details after real-call evidence.

### Session model

- A reusable agent definition is separate from a per-conversation `VoiceSession`.
- Session state is explicit; the runtime must not infer lifecycle solely from queued work.
- User and agent activity are modeled independently so listening and speaking may overlap during interruption detection.
- Transport disconnection ends the attached voice session, but the voice contract does not assume that every future transport shares a telephone-call lifecycle.

### Turns and transcripts

- STT interim results are observable but provisional.
- Only a final transcript creates a committed user message and invokes the agent.
- The initial vertical slice uses provider endpointing or a simple speech-end detector, not semantic turn detection.
- At most one active response generation belongs to a user turn.
- Turn IDs connect transcripts, agent generation, tool calls, synthesis, playout, cancellation, and telemetry.

### Agent output and synthesis

- Agent text is streamed into a conservative speakable-text segmenter.
- Complete segments may be synthesized before agent generation ends.
- Every generated speech item has an explicit handle and cancellation scope.
- Output ordering is preserved within a speech item.
- Backpressure must be observable; unbounded audio or text queues are not acceptable, though final queue limits are deferred until measured.

### Interruption

- Caller speech can interrupt speech marked interruptible.
- Interruption is a high-priority control path and must not wait behind ordinary audio or text queues.
- It cancels the active response's model stream and pending synthesis, then clears transport playout immediately.
- Writes associated with the canceled response are rejected after the clear boundary.
- Already-started business tool calls are not canceled by interruption in the first vertical slice. Their results may be retained for subsequent reasoning, but the canceled response is not resumed automatically.
- Session teardown, unlike ordinary interruption, attempts to abort every attached resource, including tools that honor cancellation.

### Tools

- The AI SDK model or agent integration owns tool selection and argument generation.
- Application code owns tool implementation, validation, authorization, and idempotency.
- A logical tool request has a stable identifier so orchestration retries do not silently duplicate side effects.
- Tool results and controlled failures return to the same conversation turn.
- Spoken progress messages and immediate/post-speech/asynchronous execution modes are deferred until a slow-tool scenario proves the need.

### Playback and speech completion

- Generation completion, synthesis completion, transport write completion, and playback completion are distinct facts.
- A speech handle completes only when its audio is believed to have played, not merely when bytes were accepted by the transport.
- Provider playback marks are authoritative when available.
- A duration-based media-clock fallback is used when marks are unavailable and must report that completion was estimated.
- Clearing playout cancels unresolved playback completion for the affected speech item.
- Conversation state tracks generated, synthesized, queued, and played progress separately. The runtime must not claim that an interrupted, unplayed suffix was heard. Exact text-to-playback reconciliation remains experimental until real provider behavior is measured.

### Errors

- Recoverable STT, tool, TTS, or transport errors are visible to the session and may allow a conversational retry.
- Fatal errors trigger orderly session teardown.
- Errors must identify the stage and turn when applicable.
- The initial kernel performs no automatic provider failover or media-socket reconnection.

### Teardown

The terminal sequence is:

1. stop accepting new work;
2. abort the session signal;
3. stop or detach STT, generation, tool, TTS, timers, and transport resources;
4. settle active speech and turn handles;
5. flush final telemetry;
6. emit exactly one terminal session event; and
7. make subsequent writes and cleanup calls safe no-ops.

Cleanup must be deterministic, idempotent, and safe even when individual resources fail while closing.

## Small voice transport contract

The voice runtime may depend only on structural capabilities such as:

- stable session identity;
- canonical inbound audio;
- outbound audio write;
- outbound queue clear;
- optional playback acknowledgement;
- abort and close lifecycle; and
- an explicit capability set.

Provider objects, webhook payloads, TwiML, Telnyx commands, rooms, participants, and tracks do not belong in this contract.

## Competitor capability matrix

This matrix records product evidence, not implementation provenance. Behavioral details should be rechecked against linked upstream documentation before they become compatibility claims.

| User problem | Observed behavior | Product | Our decision | Phase | Proving test |
| --- | --- | --- | --- | --- | --- |
| Reuse behavior across conversations | Reusable `Agent` behavior is separated from per-conversation `AgentSession` state | LiveKit Agents | Separate reusable agent definition from `VoiceSession` | Stage 1B | Two isolated sessions use one agent definition without state leakage |
| Make runtime activity understandable | Listening, thinking, and speaking are explicit session states | LiveKit Agents | Model explicit user and agent activity states | Stage 1B | Deterministic state-transition tests cover normal, interrupted, and terminal paths |
| Interrupt long speech promptly | Speech handles are interruptible and speech may be scheduled by priority | LiveKit Agents | Use explicit speech handles; start with interruptible FIFO speech and defer richer priorities | Stages 1B, 4 | Caller speech cancels generation/TTS and clears playout before stale writes |
| Support different model architectures | Cascaded, realtime, and half-cascade modes are distinct | LiveKit Agents | Build cascade first; add native realtime later as a separate engine | Stages 1B, 6 | Both engines eventually share lifecycle without claiming identical capabilities |
| Test agent logic cheaply | Text-mode tests avoid real audio | LiveKit Agents | Add deterministic voice-kernel tests first and text conversation tests later | Stages 1B, 5 | Agent/tool policy passes without audio, credentials, or network |
| Remain transport neutral | Explicit transport input and output frame boundaries | Pipecat | Define a small structural voice transport rather than a room or provider model | Stage 1B | Fake transport and Call SDK bridge pass one transport contract |
| Prevent control signals waiting behind data | Interruption and lifecycle controls bypass ordinary queues | Pipecat | Give cancellation, clear, and teardown a high-priority control path | Stages 1B, 4 | Saturated output cannot delay interruption/clear behind queued media |
| Cancel work across a pipeline | Cancellation propagates through generation, synthesis, and playout | Pipecat | Give each response one cancellation scope and clear transport on interruption | Stage 1B | One interrupt settles all response resources and produces no stale output |
| Understand latency | Per-stage latency and usage measurements are exposed | Pipecat | Record turn-correlated stage boundaries from speech start through playout | Stages 2, 4 | A real call trace contains every required timestamp and duration |
| Configure the common path clearly | Transcriber / Model / Voice is an immediately legible configuration model | Vapi | Preserve a simple cascaded construction API while keeping replaceable contracts | Stages 1B, 7 | North-star setup is understandable without reading internal pipeline code |
| Reuse an agent with per-call differences | Reusable configuration supports per-call overrides | Vapi | Keep reusable agent/runtime definitions and narrowly scoped session options | Stages 2, 7 | Two calls vary caller context without mutating shared agent configuration |
| Reach a working phone call quickly | Product optimizes for a short first-call path | Vapi | Make one excellent inbound/outbound quickstart after contracts are proven | Stage 7 | A clean downstream project completes the documented quickstart |
| Handle slow tools conversationally | Spoken progress can surround slow tool execution | Vapi | Defer progress policy until the basic tool path works and latency proves the need | Stage 4+ | Slow-tool scenario has no unexplained silence beyond the chosen threshold |
| Diagnose production conversations | Transcripts, recordings, logs, and latency traces are first-class artifacts | Vapi | Start with structured traces; do not build a hosted artifact service initially | Stages 2, 4, 5 | A failed call can be reconstructed and converted into a regression scenario |
| Test business outcomes | Evals and simulated conversations support tool mocks and CI checks | Vapi | Add deterministic component, text conversation, then simulated conversation layers | Stage 5 | CI independently tests runtime mechanics and business outcomes |
| Control first-message behavior | First-message behavior is explicit | ElevenLabs Agents | Make greeting behavior explicit in agent/session configuration | Stage 2 | Greeting is emitted once and obeys interruption/playback semantics |
| Avoid one-size-fits-all tool timing | Tools can run immediately, after speech, or asynchronously | ElevenLabs Agents | Begin with immediate tool execution; add modes only from concrete scenarios | Stage 4+ | Each added mode has an acceptance scenario proving ordering and cancellation |
| Turn incidents into quality gates | Failed conversations can become regression tests | ElevenLabs Agents | Require production failures to be representable by deterministic fixtures | Stage 5 | A captured failure reproduces locally without provider credentials |
| Avoid infrastructure adoption | Hosted systems center dashboard resources or an RTC runtime | Vapi, ElevenLabs Agents, LiveKit Agents | Keep code as source of truth and host-agnostic SDK boundaries | All stages | North-star app runs on an ordinary long-running TypeScript host without hosted agent config |
| Avoid framework complexity before it is earned | Complete frameworks include plugins, workers, jobs, and deployment conventions | LiveKit Agents, Pipecat | Stay an SDK until several applications repeat the same infrastructure needs | Stage 8 | Framework work begins only with repeated evidence from multiple applications |

### Benchmark references

- LiveKit Agents: [sessions](https://docs.livekit.io/agents/logic/sessions/), [pipeline types](https://docs.livekit.io/agents/models/pipelines/), [turn handling](https://docs.livekit.io/agents/logic/turns/), [testing](https://docs.livekit.io/agents/start/testing/)
- Pipecat: [pipeline architecture](https://docs.pipecat.ai/pipecat/learn/pipeline), [transports](https://docs.pipecat.ai/pipecat/learn/transports), [frame categories](https://docs.pipecat.ai/api-reference/server/frames/overview), [interruptions](https://docs.pipecat.ai/pipecat/fundamentals/interruptions)
- Vapi: [documentation](https://docs.vapi.ai/), [evals](https://docs.vapi.ai/observability/evals-quickstart)
- ElevenLabs Agents: [overview](https://elevenlabs.io/docs/eleven-agents/overview.md), [testing](https://elevenlabs.io/docs/eleven-agents/customization/agent-testing.mdx)

## Evidence plan

Stage 0 decisions become credible through evidence collected in later stages:

| Claim | First evidence to collect | Strong evidence to collect |
| --- | --- | --- |
| Call SDK is a sufficient voice transport | Fake voice transport contract + Call SDK bridge | Same raw duplex app over real Twilio and Telnyx |
| The voice lifecycle can be deterministic | Fake-first Vitest lifecycle | Long-running and concurrent real calls without leaks |
| Interruption is responsive and correct | Fake clock proves cancellation ordering | Real call interruption trace measures speech-to-clear latency |
| Agent logic is transport independent | North-star app uses only the voice transport contract | Unchanged app runs through Twilio and Telnyx |
| STT/TTS contracts are portable | Deterministic contract suites | Second streaming STT and TTS providers require no orchestration changes |
| The SDK is easier for the target user | Small usage sketch and vertical slice | External downstream quickstart feedback before public API freeze |

## Stage 0 gate checklist

- [x] Product thesis is explicit.
- [x] Target user and primary job are explicit.
- [x] AI SDK-first, not AI SDK-only, is an explicit capability-driven strategy.
- [x] Non-goals constrain the first product proof.
- [x] Competitive behavior is mapped to our decisions and proving tests.
- [x] One north-star application is selected.
- [x] North-star acceptance scenarios are written.
- [x] Initial package and dependency direction is documented.
- [x] Call transport, thin core, adapter, and Voice ownership boundaries are explicit.
- [x] Cross-layer architectural acceptance checks are documented.
- [x] Initial decisions cover turns, interruption, tools, playback, errors, and teardown.
- [x] The LiveKit differentiation can be explained without claiming feature superiority.
- [x] Every important architectural claim has a later evidence gate.

## Exit decision

Stage 0 is complete enough to begin the two parallel Stage 1 tracks:

- **Stage 1A:** stabilize Call SDK against real Twilio and Telnyx behavior.
- **Stage 1B:** build the unpublished Voice kernel with deterministic fakes.

This gate authorizes discovery and implementation, not publication or API stability. Package names and public types remain provisional until the two-dimensional portability claim has been proven.

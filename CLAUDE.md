## Picking the right models for workflows and subagents

Rankings, higher = better on every axis — **including cost**: a higher cost score means cheaper, i.e. less I pay (so `sonnet-5` at 5 is the cheapest, `fable-5` at 2 the most expensive). Intelligence is how hard a problem you can hand the model unsupervised. Taste covers UI/UX, code quality, API design, and copy.

| model    | cost | intelligence | taste |
| -------- | ---- | ------------ | ----- |
| sonnet-5 | 5    | 5            | 7     |
| opus-4.8 | 4    | 7            | 8     |
| fable-5  | 2    | 9            | 9     |

The Agent/Workflow `model` field takes the **short** names — `sonnet`, `opus`, and `fable` — not the versioned labels above. Full IDs if ever needed: `claude-sonnet-5`, `claude-opus-4-8`, `claude-fable-5`.

How to apply:

- These are defaults, not limits. You have standing permission to override them: if a cheaper model's output doesn't meet the bar, rerun or redo the work with a smarter model without asking. Judge the output, not the price tag. Escalating costs less than shipping mediocre work.
- Cost is a tie-breaker only; when axes conflict for anything that ships, intelligence > taste > cost.
- **Delegation / token efficiency.** Whatever model is orchestrating, treat subagents as cheap hands: delegate well-specified, mechanical, or high-volume work to the cheapest model that clears the task's quality bar (usually `sonnet-5`), and reserve the expensive models for orchestration, judgment, and taste-sensitive or ambiguous work where their intelligence actually changes the output. This holds even when `fable-5` is the orchestrator — its job is to decompose and delegate, not to personally grind bulk work. Premium driver, cheap hands is the token-efficient default. Only delegate when the subtask is big enough that the subagent's savings outweigh the cost of spinning it up and reading its result back — do trivial edits inline.
- Bulk/mechanical work (clear-spec implementation, data analysis, migrations): sonnet-5 — it's effectively free.
- Anything user-facing (UI, copy, API design) needs taste ≥ 7.
- Reviews of plans/implementations: fable-5 or opus-4.8.
- Never use Haiku.
- Claude models run via the Agent/Workflow model parameter using the short names above.

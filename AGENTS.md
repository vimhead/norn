# Norn repository guidance

These instructions govern repository changes, not downstream agent behavior. The goal is natural task-time authoring, exercising, repair, and reuse of Norn capabilities—not compulsory Norn usage.

## Scope and judgment

| Rule | GOOD | BAD |
|---|---|---|
| IF the next action is within the user's approved scope, THEN execute it and resolve uncertainty from available evidence. ELSE ask for the missing authorization or fact. | Inspect the implementation before changing it; report a concrete blocker. | Treat a question as approval for implementation, require unnecessary human approval, or substitute progress language for execution. |
| IF the user challenges an addition, THEN reconsider whether it is needed before defending its implementation or location. ELSE question new scope before adding it. | Delete an unnecessary page and the bundling added solely to support its link. | Move the page elsewhere or justify a dependency using another unnecessary addition. |
| IF existing code or an existing reference already owns the behavior or knowledge, THEN improve or use that source. ELSE add only the missing piece required by the task. | Make names and interfaces explicit; link to the relevant existing reference. | Add restating comments, duplicate manuals, a workflow catalogue, an adapter framework, or another orchestration DSL. |

## Architecture and boundaries

| Rule | GOOD | BAD |
|---|---|---|
| IF changing capability discoverability, THEN keep introduction generation, documentation, examples, and asset resolution in Norn; adapters only deliver the introduction. ELSE leave delivery unchanged. | `docs intro` points to the capability index and relevant examples. | Reintroduce a mandatory umbrella skill, copy topic maps into adapters, or inject whole manuals. |
| IF changing Pi integration, THEN inspect Pi's actual implementation and use its existing extension/package mechanisms. ELSE do not infer new requirements from a superficial analogy. | Distinguish Pi's self-documentation block from optional, on-demand skills. | Assume every capability needs a skill because Pi supports skills. |
| IF exposing docs or invocation instructions, THEN bind them to the runtime actually selected and preserve offline resolution and relative links. ELSE do not advertise another installation's assets. | Use that executable's `docs intro` and exact argv. | Invoke an older PATH binary while reading a checkout's docs, or restore GitHub documentation-link fallbacks. |
| IF changing prompt delivery, THEN preserve chained/custom prompts, prevent accumulation, and keep restricted native workers outside authoring delivery. ELSE leave session resources untouched. | Test the effective prompt and the existing worker exclusion; design author-capable worker delivery separately. | Replace the prompt, assume global extension loading is harmless to assessors, or leak unrelated context into their evidence. |

## Validation and evidence

| Rule | GOOD | BAD |
|---|---|---|
| IF validating agent orchestration or recovery, THEN exercise native Norn ownership and analyze saved outputs. ELSE use direct tools for the changed boundary. | Native workflow → worker → saved artifact → analysis; repair the affected phase of the same run. | A cosmetic Norn wrapper around an independent coordinator that owns status, retries, and unfinished delivery. |
| IF a test protects supported behavior or a required rejection/isolation contract, THEN keep it focused on that observable result. ELSE omit it. | Verify invalid input is rejected, recovery retains earlier evidence, or a restricted worker receives no authoring intro. | Assert that a deleted skill, file, or feature does not exist merely to memorialize its removal. |
| IF the user explicitly requests an experiment, THEN bound its cost and cases around a concrete question. ELSE use ordinary regression checks and do not recreate benchmark infrastructure or resume paused experiments. | Reproduce one failure and exercise its repair. | Build scoring runners for a small change, restart a stopped parser trial, or force Norn into a task to improve adoption counts. |
| IF reporting a result, THEN distinguish source observations, reproduced behavior, mocked tests, proposals, and untested claims. ELSE state the missing evidence rather than imply success. | Report offline prompt capture as such; distinguish accepted launch, failed work, and verified completion. | Treat schema validity as truth, fresh context as OS isolation, rollback as reversal of external effects, or passing staged cases as proof of natural adoption. |

## Delivery

| Rule | GOOD | BAD |
|---|---|---|
| IF changing distribution or giving installation instructions, THEN account for a user without the development checkout and distinguish local implementation from published, exercised installation. ELSE make no new distribution claim. | Check package metadata, shipped files, dependencies, and the selected executable; identify an unpushed change. | Offer only a personal absolute path, assume a local commit is remotely installable, or bundle adapter code as documentation to solve distribution. |
| IF changing this repository, THEN run checks appropriate to the diff, review it, commit only task-related files, and report the commit and validation limits. ELSE do not modify user installations or configuration. | Use the [development checks](README.md#development), Mason-backed LSP diagnostics for typed edits, and full regressions for runtime/packaging changes. | Add machinery to validate this instruction file, silently modify global settings, stage credentials or sessions, or claim checks passed when they could not run. |

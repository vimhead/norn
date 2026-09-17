# Repository direction

## What we are building

Norn is a harness-independent runtime for reusable agent capabilities. An agent should be able to discover an existing capability or author, exercise, repair, and retain a missing one while completing an ordinary task. We are developing that ability, not a fixed catalogue of workflows or a prescribed planner/reviewer architecture. Tasks that do not benefit from Norn can use ordinary tools.

## Why the model is Pi

Pi makes its own extension interfaces discoverable through a small block in its default system prompt pointing to installed documentation and examples. The agent reads the relevant material when needed and can extend Pi using its actual APIs. Optional task skills are a separate mechanism; a mandatory “use Pi” skill is not what provides this self-documentation.

Norn should have the same property across harnesses: a compact introduction leads to relevant, version-matched documentation and runnable examples, which lead to working capabilities. This keeps initial context small without limiting the agent to capabilities someone anticipated beforehand. We borrow this mechanism from Pi, not a requirement that every caller use Pi as its outer harness.

## Documentation ownership and structure

Knowledge belongs to Norn and ships with the runtime that implements it:

- `README.md` is installation and navigation, not a second manual.
- [docs/README.md](docs/README.md) is the single capability index. Focused references own individual runtime and authoring topics; the index routes readers rather than repeating those references.
- `examples/` contains complete, runnable examples that demonstrate the contracts and can be copied, changed, and exercised.
- Public types and implementation define the APIs. Live CLI discovery describes the currently loaded project, rather than a documentation-time workflow catalogue.
- `docs inspect` locates installed assets. `docs intro` supplies the compact introduction that directs an agent to them. Neither command owns delivery into a host's conversation.

This separation gives each fact one owner. It avoids a monolithic agent manual, duplicate topic maps, and an umbrella skill that becomes another source of Norn instructions. Host installation details and repository-maintainer guidance are not runtime capability references.

Documentation must match the executable actually invoked. Source/npm installations expose their local assets; standalone binaries carry an offline documentation snapshot that can be materialized as readable files. Relative links remain usable without a checkout or GitHub documentation fallback. Updating the selected runtime therefore updates its knowledge without rewriting every integration.

## Adapters are host-specific delivery

`packages/pi-norn` and `adapters/` connect Norn to host mechanisms. An adapter selects the installed Norn executable, asks it for the introduction, and delivers the result to the intended agent context. It does not assume that its own package or checkout is the runtime the user selected.

Almost everything Norn-specific is delegated to installed Norn: introduction content, asset resolution, version identity, command contracts, workflow discovery, execution, and recovery. An adapter only needs the host-specific mechanics required for what it exposes. The current Pi adapter delivers context; this is not a requirement to add execution tools to every adapter.

Prompt delivery preserves the host's existing instructions and custom prompts without accumulating duplicate introductions. Session eligibility belongs at this boundary: making Norn available to an outer authoring agent does not authorize injecting authoring context into restricted delegates. Failures should surface as failures, not trigger a fallback to another installation's knowledge.

Adapters are installable integrations, not documentation assets. Their delivery must account for users who do not have the development checkout. This boundary lets multiple hosts share the same Norn behavior instead of maintaining separate implementations.

## Package boundaries

Three packages are published: the SDK, CLI/runtime, and Pi adapter. `packages/core` is a private, source-only workspace with no separate build or publication. Consumer builds bundle the core code they use.

| Decision | GOOD | BAD |
|---|---|---|
| IF package separation would duplicate a constant, contract, or implementation, THEN extract the shared code into core. ELSE retain its current owner. | CLI and Pi adapter import one response-tool marker from core. | Copy the marker into the adapter to avoid a CLI dependency. |
| IF consuming private core code, THEN include it in the consumer's distributable build. ELSE keep normal dependencies explicit. | Packed CLI and adapter work without the core workspace. | Publish imports requiring an unpublished core package. |

## How we develop

Development follows a bounded working loop: identify an authoring or runtime limitation, inspect the relevant source and contract, implement the smallest missing behavior, exercise it, inspect its outputs, and repair it. The result should remain usable by another caller, not depend on the development conversation.

| Decision | GOOD | BAD |
|---|---|---|
| IF a change concerns a runtime contract, THEN change Norn and its owning reference/example. ELSE keep host-specific delivery in the adapter. | Add a discovery contract once in Norn and consume it from a host. | Reimplement schemas, documentation lookup, or workflow state in each adapter. |
| IF validating agent orchestration or recovery, THEN let native Norn workflows own that execution and analyze saved artifacts. ELSE test the changed boundary directly. | Exercise Norn agent → saved output → analysis and repair the affected phase. | A cosmetic Norn wrapper around an independent coordinator, or orchestration added to a trivial task. |
| IF adding a test, THEN identify the supported behavior or required failure/isolation contract it protects. ELSE leave the suite unchanged. | Verify usable docs from a standalone installation, effective prompt delivery, or recovery retaining earlier work. | Assert that a deleted feature stays absent, or create a benchmark framework for a bounded change. |
| IF changing code, THEN run the [development checks](README.md#development) and exercise the affected behavior; use the full suite for runtime or packaging changes. ELSE validate the actual artifact changed. | Distinguish an offline SDK test, a native binary run, and an untested installation path. | Treat schema validity or passing staged examples as proof of task correctness or natural adoption. |

# Norn documentation

Norn capabilities are ordinary TypeScript plugins: an agent can write one during a task, register it in that project, exercise it, change it, and retain it for another caller. No generated project hierarchy or separate compilation step is required.

## Read by task

| Task | Documentation | Runnable example |
|---|---|---|
| Create, register, or diagnose a plugin | [Projects and loading](projects.md), [Workflow authoring](workflows.md) | [Create → run → change](../examples/minimal-workflow/README.md) |
| Discover contracts or invoke Norn from another harness | [CLI and client](cli.md) | [Create → run → change](../examples/minimal-workflow/README.md) |
| Delegate work with explicit inputs and structured results | [Agents](agents.md) | [Worker → saved artifact → analysis](../examples/worker-then-analysis/README.md) |
| Retain evidence or choose a filesystem boundary | [State, artifacts, and workspaces](persistence.md) | [Worker → saved artifact → analysis](../examples/worker-then-analysis/README.md) |
| Reuse a workflow with a caller-selected continuation | [Composition](composition.md) | [Worktree development loop](../examples/worktree-development-loop/README.md) — larger, optional |
| Repair a failed run without repeating earlier work | [Recovery and gates](recovery.md) | [Analysis-only repair](../examples/worker-then-analysis/README.md#repair-only-the-analysis-step) |

[Public types](../src/api.ts) are the authoritative authoring interface. CLI discovery exposes the currently loaded project, not a documentation-time workflow catalogue. See [installation](../README.md#installation) for runtime setup.

| Decision | GOOD | BAD |
|---|---|---|
| IF a task needs persisted workflow control, independently prompted workers, or a callable capability, THEN use the relevant pages and author only the missing capability. ELSE solve it directly. | A retryable delivery step consuming saved assessments. | Wrapping a literal text replacement in a workflow solely because Norn is installed. |
| IF the executable differs from the installation containing these docs, THEN locate matching docs or invoke this installation explicitly using [CLI setup](cli.md#select-the-runtime). ELSE use its local examples and types. | A source checkout paired with its own `bin/norn.mjs`. | Reading a new checkout while invoking an older `PATH` binary. |

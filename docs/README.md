# Norn documentation

Norn capabilities are ordinary TypeScript workflows: an agent can write one during a task, register it in that project, exercise it, change it, and retain it for another caller. No generated project hierarchy or separate compilation step is required.

## Read by task

| Task | Documentation | Runnable example |
|---|---|---|
| Build, register, or diagnose workflows with the Norn SDK | [Projects and loading](projects.md), [Workflow authoring](workflows.md) | [Create → run → change](../examples/minimal-workflow/README.md) |
| Define TypeBox schemas, constraints, or codecs | [TypeBox schemas](schemas.md) | — |
| Discover contracts or invoke Norn from another harness | [CLI and client](cli.md) | [Create → run → change](../examples/minimal-workflow/README.md) |
| Configure providers, models, and authentication for Norn agents | [Providers and authentication](providers.md) | — |
| Delegate work with explicit inputs and structured results | [Norn agents](agents.md) | [Norn agent → saved artifact → analysis](../examples/agent-then-analysis/README.md) |
| Initialize resources, attach agent tools, or coordinate file mutations | [Resources and locking](resources.md) | [Explicit shared state](../examples/shared-state/README.md) |
| Implement a custom resource and adapter to coordinate concurrent agents | [Resource contracts](resources.md) | [Example-local work queue](../examples/coordinating-multiple-agents/README.md) |
| Retain evidence or choose a filesystem boundary | [Persistence, artifacts, and workspaces](persistence.md) | [Norn agent → saved artifact → analysis](../examples/agent-then-analysis/README.md) |
| Reuse a workflow with a caller-selected continuation | [Composition](composition.md) | [Caller-selected continuation](../examples/caller-selected-continuation/README.md) |
| Repair a failed run without repeating earlier work | [Recovery and gates](recovery.md) | [Analysis-only repair](../examples/agent-then-analysis/README.md#repair-only-the-analysis-step) |

[Public types](../packages/sdk/src/api.ts) define the Norn SDK's authoring interface. CLI discovery exposes the currently loaded project, not a documentation-time workflow catalogue. See [installation](../README.md#installation) for runtime setup.

| Decision | GOOD | BAD |
|---|---|---|
| IF a task needs persisted workflow control, independently prompted Norn agents, or a callable capability, THEN use the relevant pages and author only the missing capability. ELSE solve it directly. | A retryable delivery step consuming saved assessments. | Wrapping a literal text replacement in a workflow solely because Norn is installed. |
| IF the executable differs from the installation containing these docs, THEN locate matching docs or invoke this installation explicitly using [CLI setup](cli.md#select-the-runtime). ELSE use its local examples and types. | A source checkout paired with its own `packages/cli/bin/norn.mjs`. | Reading a new checkout while invoking an older `PATH` binary. |

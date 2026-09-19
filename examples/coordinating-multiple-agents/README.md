# Coordinating multiple Norn agents

This example implements its own queue and agent adapter using Norn's existing [resource contracts](../../docs/resources.md). Neither the queue nor `QueueAdapter` is a built-in Norn API.

- [`work-queue.ts`](work-queue.ts): note/result schemas, file-backed `WorkQueue`, and a plain `NornResourceDefinition` named `workQueueDefinition`.
- [`queue-adapter.ts`](queue-adapter.ts): `QueueAdapter({queue})` implements `NornAgentResourceAdapter`, exposing claim, acknowledgment and status tools for one queue.
- [`plugin.ts`](plugin.ts): seed notes, explicitly start two Norn agents per round, close both sessions before a checkpoint, and verify persisted results.

```ts
import { QueueAdapter } from "./queue-adapter.ts";
import { workQueueDefinition } from "./work-queue.ts";

const queue = await run.resources.ensure(workQueueDefinition);
const agentSession = await run.agents.createSession({
  label: "summary-1",
  cwd: paths.workspace,
  tools: [],
  resourceAdapters: [QueueAdapter({ queue })],
});
```

The workflows own prompting and disposal. Resource initialization and agent attachment remain separate; the queue does not start or schedule agents.

## Run

[Select the matching runtime](../../docs/cli.md#select-the-runtime), copy this entire directory into a writable task directory, and enter it. Norn agents require [configured providers/authentication](../../docs/providers.md). The supplied four-note input normally uses two rounds: four agent prompts, up to two concurrently. Model/thinking settings come from the configured runtime and are not overridden.

```bash
norn workflows inspect coordinatingAgents.start
norn runs start coordinatingAgents.start < input.json
norn runs wait <returned-run-id>
norn runs inspect <returned-run-id>
```

Success reports `status: completed`, `data.processed: 4`, and `data.summariesPath: "summaries.json"`, relative to the inspected `run.paths.workspace`. The file contains each input ID, original source, summary, exact source quotation and delivery count. Round reports are in that workspace's `rounds/` directory; [agent session evidence](../../docs/agents.md#response-contract-and-evidence) is retained separately.

Verification checks persisted results for coverage, schemas, unchanged sources and quotation membership—not summary quality or completeness. Agent success reports alone cannot complete the run.

## Queue boundaries

The local format retains at most 12 notes and their results in `current/resources/summaries/queue.json`. Note/result schemas bound every tool payload; there is no general schema registry, configurable permissions framework or multi-queue adapter. Workflow code enqueues notes and inspects results. Norn agents receive only `queue_claim`, `queue_acknowledge` and counts-only `queue_status`, not enqueue or filesystem tools. Normal [agent resource loading](../../docs/agents.md#prompts-tools-and-resource-loading) still applies; this is not an OS sandbox.

A claim lasts five minutes, measured by the local wall clock. Repeating a live owner's claim returns the same note/token; another binding has a distinct owner even when labels match. Expiry makes abandoned work available with a new token. Stale, expired and wrong-owner acknowledgments fail. Disposal does not acknowledge or release work. This bounded example has no renewal, subscriptions or automatic retry scheduler.

Enqueue retries must use the same ID and text. Acknowledgment saves the result and completion together under one short file lock, with atomic file replacement; identical successful retries are idempotent, conflicting results fail. Locks are not held across model turns. Acknowledgment records processing, not semantic approval. There is no separate ledger or external-effect transaction.

## Recover a failed round

Use the [recovery procedure](../../docs/recovery.md#source-repair-and-rollback) after inspecting and repairing the failure. Stop every queue user before rollback and preserve wanted failed-attempt evidence outside `current/`. Select the actual checkpoint before the affected round, then resume without args.

Completed earlier rounds survive that boundary. Work after it is rolled back and can repeat, including a successful peer's work from a failed round. Fresh bindings get new owners. Restoring a snapshot containing live claims retains their original expiry; tokens do not fence arbitrary rollback or external effects. The supplied workflow closes its sessions and checks for unfinished claims before taking a round boundary.

| Decision | GOOD | BAD |
|---|---|---|
| IF adapting this example, THEN change its local schemas, instructions and verification together, updating resource configuration for incompatible storage changes. ELSE keep the supplied note contract. | Replace quotation checks with the new task's evidence checks. | Treat any acknowledged JSON as a correct domain result. |
| IF fixing an invalid result, THEN choose a checkpoint before the producing round. ELSE preserve earlier valid rounds. | Repair the instruction and retry the affected suffix. | Overwrite an acknowledged result with its old token. |
| IF work has external effects, THEN reconcile them or provide effect-owned idempotency before retry. ELSE keep results in the atomic acknowledgment. | Look up an external delivery by its stable operation ID. | Assume queue rollback also undoes a remote delivery. |

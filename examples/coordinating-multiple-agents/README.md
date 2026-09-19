# Coordinating multiple Norn agents

This example implements its own SQLite queue in the [workflow workspace](../../docs/persistence.md#workflow-owned-storage) and supplies ordinary [agent tools](../../docs/agents.md#custom-tools) for it. SQLite is available through `node:sqlite`; no separate database package is needed.

- [`work-queue.ts`](work-queue.ts): note/result schemas and a transactional `WorkQueue`.
- [`queue-tools.ts`](queue-tools.ts): `createQueueTools({queue})` returns claim, acknowledgment and status tools for one queue owner.
- [`plugin.ts`](plugin.ts): seed notes, explicitly start two Norn agents per round, close both sessions before a checkpoint, and verify persisted results.

```ts
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createQueueTools } from "./queue-tools.ts";
import { WorkQueue } from "./work-queue.ts";

const queue = await WorkQueue.open({
  path: join(paths.workspace, "queue.sqlite"),
  create: false,
  leaseDurationMs: 300_000,
  now: Date.now,
  createToken: randomUUID,
});
const queueTools = createQueueTools({ queue });
const agentSession = await agents.createSession({
  label: "summary-1",
  cwd: paths.workspace,
  customTools: queueTools,
  tools: queueTools.map(tool => tool.name),
});
```

The entrypoint creates the queue with `create: true`; later steps reopen it with `create: false`. The complete workflow owns prompting and session disposal, and closes the queue in `finally` before returning a transition. Each agent receives a fresh `createQueueTools({ queue })` result so competing agents do not share claim ownership. The queue does not start or schedule agents.

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

The queue retains at most 12 notes and their results in `queue.sqlite` under `paths.workspace`. Note/result schemas bound every tool payload. Workflow code enqueues notes and inspects results. Norn agents receive only `queue_claim`, `queue_acknowledge` and counts-only `queue_status`, not enqueue or filesystem tools. Normal [agent resource loading](../../docs/agents.md#prompts-tools-and-resource-loading) still applies; this is not an OS sandbox.

A claim lasts five minutes, measured by the local wall clock. Repeating a live owner's claim returns the same note/token; another `createQueueTools` call creates a distinct owner. Expiry makes abandoned work available with a new token. Stale, expired and wrong-owner acknowledgments fail. Closing an agent session does not acknowledge or release work. This bounded example has no renewal, subscriptions or automatic retry scheduler.

Enqueue retries must use the same ID and text. Acknowledgment saves the result and completion together in a SQLite transaction; identical successful retries are idempotent, conflicting results fail. Transactions do not span model turns. Acknowledgment records processing, not semantic approval. There is no separate ledger or external-effect transaction.

## Recover a failed round

Use the [recovery procedure](../../docs/recovery.md#source-repair-and-rollback) after inspecting and repairing the failure. Stop every queue user before rollback and preserve wanted failed-attempt evidence outside `current/`. Select the actual checkpoint before the affected round, then resume without args.

Completed earlier rounds survive that boundary. Work after it is rolled back and can repeat, including a successful peer's work from a failed round. Fresh tool sets get new owners. Restoring a snapshot containing live claims retains their original expiry; tokens do not fence arbitrary rollback or external effects. The supplied workflow closes its sessions and checks for unfinished claims before taking a round boundary.

| Decision | GOOD | BAD |
|---|---|---|
| IF adapting this example, THEN change its local schemas, instructions and verification together. ELSE keep the supplied note contract. | Replace quotation checks with the new task's evidence checks. | Treat any acknowledged JSON as a correct domain result. |
| IF fixing an invalid result, THEN choose a checkpoint before the producing round. ELSE preserve earlier valid rounds. | Repair the instruction and retry the affected suffix. | Overwrite an acknowledged result with its old token. |
| IF work has external effects, THEN reconcile them or provide effect-owned idempotency before retry. ELSE keep results in the atomic acknowledgment. | Look up an external delivery by its stable operation ID. | Assume queue rollback also undoes a remote delivery. |

# Recovery and gates

## Inspect before retrying

```bash
norn runs inspect <run>
norn runs logs <run>
norn runs checkpoints <run>
```

`<run>` is the ID or generated name returned by start. Inspection exposes status, health, current workflow, failure/interruption, and outcome metadata. Logs are newline-delimited events; agent and command evidence is retained in the run's current files. [CLI details](cli.md) explain launch/wait semantics.

Checkpoints are taken at run start, successful transitions, gate interruptions, and completion. Failure/stopping does not create a new successful boundary. A transition snapshot contains the saved preceding work and the next step's params.

| Observed state | Action | GOOD | BAD |
|---|---|---|---|
| `failed` or `stopped` | IF execution must continue, THEN repair the cause, select an earlier active checkpoint, rollback, and resume without params. ELSE leave the run inactive. | Retry delivery from the transition after assessment. | Resume a failed run directly or restart all assessments. |
| `interrupted` | IF the declared decision is available within authorization, THEN resume with the permitted param patch. ELSE retain the interruption and identify the missing input. | An authorized agent evaluates evidence and supplies the decision. | Assume every gate requires a human or edit protected evidence fields. |
| `pendingResume` | IF retry is intended, THEN resume with no params. ELSE leave the restored boundary untouched. | `norn runs resume <run> </dev/null`. | Try to override arbitrary saved inputs through resume. |
| `running` with unhealthy inspection | IF the executor is no longer healthy, THEN inspect ownership and reconcile effects before recovery. ELSE monitor active execution. | Check run health and command evidence before retry. | Start a competing executor or equate stale status with successful delivery. |

## Source repair and rollback

```bash
# Edit the registered plugin source, then inspect its current contract.
norn workflows inspect <workflow-id>
norn runs checkpoints <run>
norn runs rollback <run> <checkpoint-id>
norn runs resume <run> </dev/null
norn runs wait <run>
```

Use the actual `cp_...` ID from checkpoint listing, not an index or invented name. Rollback restores the run's current files and active checkpoint history, then prepares the saved step for resume. A fresh CLI executor loads current plugin source. It does not restore the source version that created the checkpoint, and saved params/state must remain compatible with the repaired implementation.

Rollback restores only [snapshotted files](persistence.md). It does not undo project-root edits, remote deliveries, or other external effects. Re-execution is not an exactly-once guarantee.

| Decision | GOOD | BAD |
|---|---|---|
| IF retry can repeat an external effect, THEN reconcile its evidence or use an idempotent effect contract before resuming. ELSE re-execute the saved step. | Look up the existing delivery receipt by operation ID. | Assume an interrupted HTTP call did nothing. |
| IF the defect is in analysis only, THEN choose the draft-to-analysis transition. ELSE choose a boundary before the invalid producer and regenerate its output. | Preserve a valid draft while repairing the analyzer. | Repeatedly analyze a draft whose evidence is itself invalid. |

The [agent example's repair exercise](../examples/agent-then-analysis/README.md#repair-only-the-analysis-step) demonstrates preserving a live Norn agent result through analysis failure and source repair.

## Declared gates

A workflow can declare:

```ts
gate: { enabled: true, fields: ["decision", "notes"] }
```

Its params schema must include those top-level fields. An optional implementation `gate.describe(run, params, config)` explains the decision. The CLI uses pause mode: a gate interrupts **before** execution, including direct starts of a gated workflow.

Resume stdin has the form `{"params":{"decision":"accept","notes":"Evidence checked"}}`. With declared `fields`, the patch merges into saved object params and rejects non-gate keys; without `fields`, resume supplies replacement params. The merged/replacement value is schema-validated. A gate is a persisted control boundary, not an automatic human approval mechanism or an authorization system.

Sources: [scheduler and resume](../src/internal/engine.ts), [saved state and param merging](../src/internal/run-state.ts), [snapshot restoration](../src/internal/run-store.ts), [CLI lifecycle](../src/cli.ts).

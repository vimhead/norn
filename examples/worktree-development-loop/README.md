# Workspace development loop example

A larger, optional Norn workflow example for one Git repository. Separate planning,
implementation, and review steps let callers inspect saved evidence and recover at
phase boundaries; a gate pauses for a review decision. Neither these roles nor the
directory layout are required by Norn. The [minimal workflow](../minimal-workflow/README.md)
is a single-step starting point.

It registers an entrypoint workflow named **Workspace development loop**. The
workflow:

1. clones the configured repository into `paths.workspace/repo`;
2. passes the repository path and retained file paths through workflow arguments;
3. passes explicit cwd values to agents and commands;
4. plans once, then loops through implementation and automated review;
5. routes automated review through a gated review router;
6. completes on `accept`, fails cleanly on `blocked`, and fails cleanly when the
   max iteration count is reached.

## Source layout

| File or directory | Role in this example |
|---|---|
| [scope.ts](scope.ts) | Declares the shared namespace and repository configuration. |
| [plugin.ts](plugin.ts) | Exports the workflows for registration. |
| [workflows/development-loop/](workflows/development-loop/) | Defines entrypoint inputs and repository setup. |
| [workflows/planning/](workflows/planning/), [workflows/implementation/](workflows/implementation/), [workflows/review/](workflows/review/) | Define each agent step's inputs and execution. |
| [workflows/review-router/](workflows/review-router/) | Defines editable gate fields and routes the chosen decision. |

## Setup

[Select the matching runtime](../../docs/cli.md#select-the-runtime), copy this
entire directory into a writable task directory, and `cd` into the copy. Git and
Bash must be on `PATH`. Configure [authentication and a default model](../../docs/providers.md)
before starting; this example makes live model calls.

In [norn.project.json](norn.project.json), replace
`config.worktreeDevelopmentLoop.repositoryRoot` with the **absolute path** to a
local Git repository containing at least one commit. Relative paths such as `.`
resolve from the run workspace, not the directory containing the project file.
The workflow clones committed content at `baseRef`; uncommitted changes,
untracked files, and untracked dependencies are not copied. Choose a task and
checks suitable for a fresh clone.

## Start and inspect

```bash
norn project inspect
norn workflows inspect worktreeDevelopmentLoop.developmentLoop
norn workflows inspect worktreeDevelopmentLoop.reviewRouter
printf '%s\n' '{"args":{"task":"Add tests","baseRef":"HEAD","maxIterations":3}}' | norn runs start worktreeDevelopmentLoop.developmentLoop
```

Discovery should report `isComplete: true`. Copy the returned `run.id`:

```bash
RUN=<returned-run-id>
norn runs wait "$RUN"
norn runs inspect "$RUN"
```

After planning, implementation, and automated review succeed, expect
`run.status: interrupted` at `worktreeDevelopmentLoop.reviewRouter`, **not** a
completed run. Inspection exposes the iteration, proposed decision, summary, and
`automatedReviewPath` in `run.interruption.args`. A command or agent failure
can end the run before this gate; inspect the failure instead of attempting approval.

## Review and resume

The example's file and repository paths are relative to `run.paths.workspace`,
reported by run inspection. For the interrupted iteration `N`, inspect these files
in that directory:

- `planning/plan.md` — the saved plan.
- `implementation/iteration-N-status.txt` — recorded Git status.
- `review/iteration-N-diff.txt` — recorded working-tree diff.
- `review/iteration-N-automated.json` — the agent's proposed decision and summary.

Inspect the actual clone as well:

```bash
WORKSPACE=<run.paths.workspace-from-inspection>
git -C "$WORKSPACE/repo" status --short
git -C "$WORKSPACE/repo" diff HEAD -- .
```

Check new files, any commits made since the selected base revision, and evidence
for the task's required checks. An automated `accept` is a recommendation, not
proof that the task succeeded.

Only `decision` and `summary` are gate-editable fields:

| Decision | Result after resume |
|---|---|
| `accept` | Complete with outcome data `status: done`, including at the iteration limit. |
| `revise` | Run the next implementation/review iteration, then interrupt again. At `maxIterations`, fail with outcome data `status: needs-attention`. |
| `blocked` | Fail with outcome data `status: blocked` and the supplied summary. |

For an authorized acceptance decision after checking the work:

```bash
printf '%s\n' '{"args":{"decision":"accept","summary":"Verified changes and relevant checks."}}' | norn runs resume "$RUN"
norn runs wait "$RUN"
norn runs inspect "$RUN"
```

To request changes, supply `decision: "revise"` and concrete feedback in `summary`;
repeat the review/resume procedure at the next interruption. Use `blocked` with
the reason work cannot proceed. Leave the run interrupted until a decision is
available. The [gate reference](../../docs/recovery.md#declared-gates) defines
resume input and protected fields.

## Verify and retain the result

After acceptance, expect `run.status: completed`, `run.health: healthy`, and
`run.outcome.workflowId: worktreeDevelopmentLoop.reviewRouter`. Outcome metadata
includes `data.planPath`, `data.reviewPath`, `data.status: done`,
`data.repositoryPath: "repo"`, and the iteration count. The review file is
`review/iteration-N-decision.json`, retaining the chosen decision and
`automatedReviewPath`.

The resulting repository is `repo` inside the inspected `run.paths.workspace`. There is no
automatic step to merge, push, or copy its changes back to the original repository;
retain or transfer the wanted changes before deleting the run. This workspace is
[not a filesystem sandbox](../../docs/persistence.md#filesystem-boundaries).

For failed runs and source repairs, use the existing
[inspection, rollback, and resume procedure](../../docs/recovery.md#source-repair-and-rollback).

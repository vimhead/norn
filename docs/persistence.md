# Persistence, artifacts, and workspaces

## Choose what survives

| Value | Lifetime and access |
|---|---|
| Local variables / module memory | Current invocation or executor only; not a resume contract. |
| `run.resources` data | Per-run data included in checkpoint recovery. Resume reopens handles; closures do not survive. |
| `run.artifacts` | Text files addressed by `{ path }` relative to this run's artifacts directory. Write content, pass the ref, read and validate at the consumer. |
| Outcome metadata | Caller-facing summary, artifact/log refs and small data, exposed by run inspection. |
| Workflow args | Explicit input to the current/next step, persisted for recovery. |

Use arguments for step inputs, artifacts for retained outputs, and [resources](resources.md) for mutable storage. The [shared-state example](../examples/shared-state/README.md) provides a custom store; Norn has no dedicated application-state API. The [agent example](../examples/agent-then-analysis/plugin.ts) saves a draft artifact and passes its reference explicitly to analysis.

Artifact refs are paths, not content hashes, and writing to the same path replaces its content. An artifact read returns text, so a JSON consumer still needs parsing and schema validation. Separate artifact and resource writes are not one transaction.

| Decision | GOOD | BAD |
|---|---|---|
| IF earlier work must survive retry of a later step, THEN persist it before a transition and recover from that boundary. ELSE expect the active step to be repeated. | Save assessments, transition to delivery, retry delivery. | Keep assessments in a closure and restart the entire coordinator. |
| IF evidence must remain distinguishable across attempts, THEN use distinct artifact paths or retain the relevant checkpoint. ELSE document intentional replacement. | `attempt-2/analysis.json`. | Overwrite `analysis.json` while promising both revisions remain in the current files. |
| IF a ref crosses into another run or project, THEN transfer its content and establish a destination-owned ref. ELSE use the ref within its original run. | Read and copy the source run's artifact before invoking a separate consumer run. | Pass `{ "path": "draft.json" }` to an unrelated run and expect global resolution. |

## Filesystem boundaries

Each run is stored under `<project>/.norn/runs/<id>/`:

```text
current/
  workspace/       working files
  artifacts/       capability evidence and results
  resources/       resource definitions and data
  run-state.json   scheduler state
  manifest.json    recorded events
  logs/            command and agent output
  sessions/        Pi conversations
  checkpoints.json
locks/             transient resource/file coordination; not snapshotted
store/             snapshot manifests and content-addressed objects
```

Every workflow and gate description receives `paths`:

| Path | Directory | Checkpoint and rollback behavior |
|---|---|---|
| `paths.project` | Absolute root of the loaded project | Project edits are excluded. |
| `paths.run` | Absolute, initially empty run workspace | Workspace files are saved in checkpoints and restored on rollback. |

Use ordinary path utilities to address files or subdirectories. The workspace is not a checkout or copy of the project. Commands and agents require an explicit absolute `cwd`, such as `paths.project`, `paths.run`, or a prepared subdirectory.

The dedicated run worker uses an empty, read-only cwd to guard against accidental relative writes to the project. This is not a security sandbox: enforcement depends on filesystem permissions and process privileges. Explicit project paths and other external locations remain accessible.

| Decision | GOOD | BAD |
|---|---|---|
| IF work needs existing project files, THEN use `paths.project` or explicitly prepare a copy/worktree inside `paths.run`. ELSE use the empty run workspace. | A verifier chooses `cwd: paths.project`; an editing workflow prepares its own worktree. | Run `npm test` in an empty workspace and assume the repository is present. |
| IF rollback must undo a change, THEN keep it in snapshotted run files or separately manage the external effect. ELSE do not promise rollback of that change. | Reconcile a project-root edit or remote delivery explicitly. | Assume snapshots restore project workflow source, remote APIs, or symlink targets. |

Snapshots cover `current/`, preserve symlinks as links rather than copying targets, and do not include project-root source. [Recovery](recovery.md) defines when snapshots are taken and how to select a retry boundary.

Sources: [artifacts](../packages/cli/src/internal/artifacts.ts), [run paths](../packages/cli/src/internal/run.ts), [snapshot store](../packages/cli/src/internal/run-store.ts).

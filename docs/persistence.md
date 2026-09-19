# Persistence, files, and workspaces

## Choose what survives

| Value | Lifetime and access |
|---|---|
| Local variables / module memory | Current invocation or executor only; not a resume contract. |
| Workspace files | Ordinary files under `paths.workspace`, saved in checkpoints and restored on rollback. |
| Outcome metadata | Caller-facing summary, log refs and workflow-defined `data`, exposed by run inspection. |
| Workflow args | Explicit input to the current/next step, persisted for recovery. |

Use arguments for step inputs and workspace files for retained content. The [shared-state example](../examples/shared-state/README.md) owns a SQLite store in its workspace. The [agent example](../examples/agent-then-analysis/plugin.ts) writes a JSON file with ordinary filesystem APIs and passes its path to analysis.

File names, formats, and path conventions belong to the workflow. Return relevant paths in outcome `data`; declare whether they are absolute or relative and, for relative paths, their base. Norn does not interpret arbitrary strings in args or outcomes as paths. A JSON consumer still needs parsing and schema validation.

| Decision | GOOD | BAD |
|---|---|---|
| IF earlier work must survive retry of a later step, THEN persist it before a transition and recover from that boundary. ELSE expect the active step to be repeated. | Save assessments, transition to delivery, retry delivery. | Keep assessments in a closure and restart the entire coordinator. |
| IF evidence must remain distinguishable across attempts, THEN use distinct file paths or retain the relevant checkpoint. ELSE document intentional replacement. | `attempt-2/analysis.json`. | Overwrite `analysis.json` while promising both revisions remain in the current files. |
| IF a consumer receives a relative file path, THEN resolve it against the base declared by the workflow. ELSE use the absolute path directly. | Resolve a workspace-relative `draftPath` against `run.paths.workspace` from inspection. | Resolve it against the caller's cwd or the run storage root. |

## Workflow-owned storage

Workflows can use ordinary filesystem APIs or a storage library. Storage formats, initialization, validation, and concurrency belong to that application code. The [shared-state](../examples/shared-state/README.md) and [work-queue](../examples/coordinating-multiple-agents/README.md) examples use SQLite through `node:sqlite`, without a separate dependency installation.

Finish writers and close database connections before returning a transition. Checkpoints preserve files, not live connections or closures; later steps reopen storage from `paths.workspace`. Stop all users of a store before rollback. An external database is not restored by a workspace checkpoint.

| Decision | GOOD | BAD |
|---|---|---|
| IF agents mutate shared data concurrently, THEN use storage transactions or serialize the complete mutation. ELSE ordinary independent file writes can suffice. | Claim and acknowledge queue work transactionally. | Read the same JSON file in two agents and overwrite each other's changes. |
| IF returning a transition after database work, THEN commit writes and close owned handles before returning. ELSE the workspace may not contain a consistent recoverable database. | Close the SQLite store in `finally`. | Leave writers running while the next step begins. |

## Filesystem boundaries

Each run is stored under `<project>/.norn/runs/<id>/`:

```text
current/
  workspace/       working files
  run-state.json   scheduler state
  manifest.json    recorded events
  logs/            command and agent output
  sessions/        Pi conversations
  checkpoints.json
locks/             runtime locks; not snapshotted
store/             snapshot manifests and content-addressed objects
```

Every workflow and gate description receives `paths`:

| Path | Directory | Checkpoint and rollback behavior |
|---|---|---|
| `paths.project` | Absolute root of the loaded project | Project edits are excluded. |
| `paths.workspace` | Absolute, initially empty run workspace | Workspace files are saved in checkpoints and restored on rollback. |

Run start, list, inspect, and wait results expose these same directories under `run.paths`. The separate `run.path` is the storage root, not the workspace. These locations remain discoverable for interrupted and failed runs as well as completed ones.

Use ordinary path utilities to address files or subdirectories. The workspace is not a checkout or copy of the project. Commands and agents require an explicit absolute `cwd`, such as `paths.project`, `paths.workspace`, or a prepared subdirectory.

The dedicated run worker uses an empty, read-only cwd to guard against accidental relative writes to the project. This is not a security sandbox: enforcement depends on filesystem permissions and process privileges. Explicit project paths and other external locations remain accessible.

| Decision | GOOD | BAD |
|---|---|---|
| IF work needs existing project files, THEN use `paths.project` or explicitly prepare a copy/worktree inside `paths.workspace`. ELSE use the empty run workspace. | A verifier chooses `cwd: paths.project`; an editing workflow prepares its own worktree. | Run `npm test` in an empty workspace and assume the repository is present. |
| IF rollback must undo a change, THEN keep it in snapshotted run files or separately manage the external effect. ELSE do not promise rollback of that change. | Reconcile a project-root edit or remote delivery explicitly. | Assume snapshots restore project workflow source, remote APIs, or symlink targets. |

Snapshots cover `current/`, preserve symlinks as links rather than copying targets, and do not include project-root source. [Recovery](recovery.md) defines when snapshots are taken and how to select a retry boundary.

Sources: [public path and outcome types](../packages/sdk/src/api.ts), [snapshot store](../packages/cli/src/internal/run-store.ts).

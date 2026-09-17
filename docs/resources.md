# Run resources and exclusive locking

## Initialization is separate from attachment

Every run initializes or reopens `run.resources` before workflow execution and automatically ensures workflow state through that manager. The state handle is exposed as `run.state`, with `get`, `getOptional` and `set`. Creating storage does not populate declared fields, including schemas with defaults. Factory registration state remains in-memory and separate.

`run.resources.ensure(definition)` returns a shared handle within that manager. A definition contains `name`, `kind`, JSON `configuration`, and `initialize({directory, files, mode})`. Names are single alphanumeric/underscore/hyphen identifiers starting with an alphanumeric character. Identity/configuration conflicts fail; `configuration` owns format/version compatibility.

The manager persists identity before calling the initializer and marks successful initialization afterward. `mode: "create"` also covers retry of an interrupted initialization; `mode: "open"` means an earlier initialization succeeded. Initializers own their data schema and must reject missing/incompatible data when reopening. Failed initialization remains visible and retryable, not a successful empty resource. Definitions have no filesystem effects until ensured.

| Decision | GOOD | BAD |
|---|---|---|
| IF implementing an initializer, THEN make create retries preserve existing data and open validate existing storage. ELSE do not register the definition. | Validate a file left by an interrupted create before reusing it. | Truncate the file each time `ensure` calls the initializer. |
| IF a resource format changes incompatibly, THEN change its declared configuration and provide an explicit migration. ELSE reopen the same format. | A mismatching `format` fails. | Reinterpret old bytes under an unchanged format declaration. |

Resources are run-scoped and persisted under `current/resources/`; built-in workflow values retain their existing `current/state.json` location. All workflow contexts in one executor share the manager. A resumed executor reopens handles, not closures. Resource data participates in normal [checkpoint recovery](recovery.md). Cross-run storage, queues, ledgers, and scheduler/agent activation are not supplied by this API.

## Explicit agent attachment

The [runnable shared-state example](../examples/shared-state/README.md) uses:

```ts
resourceAdapters: [StateAdapter({
  state: run.state,
  fields: [
    { field: manifest.states.source, access: "read" },
    { field: manifest.states.copiedText, access: "write" },
  ],
})]
```

`StateAdapter` is exported from `norn` and accepts the public workflow-state interface, without a storage path. `read-write` is also supported. This adapter adds `norn_state_list`, `norn_state_get`, and `norn_state_set`, including when `tools: []` is requested. Discovery lists only selected fields and their schemas/permissions. Each operation checks its grant; setting validates against the declared field schema. Unset reads return `isSet:false`.

List/get output is serialized JSON in bounded text pages. Requests specify UTF-16 `offset` and `limit` (1–10000); responses include `text`, `nextOffset` and a content `revision`. Pages are not a pinned snapshot. Set operations persist complete field values; get followed by set is not a transaction.

Custom adapters implement `NornAgentResourceAdapter`: a unique name and `bind({runId, label})` returning a `NornAgentResourceBinding` with tools and async `dispose()`. An adapter can expose one or several resource handles; initializing storage does not construct or attach tools. Session creation and one-shot prompting accept adapters through `resourceAdapters`, not through the resource manager or state handle directly. The runner knows only the adapter contract, not individual resource kinds. Attached tools are activated with the normal response tool. Duplicate adapter names and collisions with built-ins, the response tool, other adapters or already-loaded extension tools fail. Successful bindings are cleaned up in reverse order on session disposal or later creation failure. An initializer/binder that throws before returning its handle owns cleanup of its partial allocations.

| Decision | GOOD | BAD |
|---|---|---|
| IF a Norn agent needs state access, THEN explicitly select its fields and permissions. ELSE omit the attachment. | A reviewer reads a pinned candidate field. | Automatically expose all manifest fields to every session. |
| IF combining pages, THEN compare their revisions and restart the read when they differ. ELSE use a single returned page as a fragment only. | Re-read a value changed between pages. | Concatenate pages from different revisions. |
| IF disposing a binding, THEN release session-local handles only. ELSE retain the resource for later sessions. | Close a subscription. | Delete workflow state when its agent exits. |

The attachment never exposes internal scheduler/checkpoint control state. It is a cooperative tool boundary, not a sandbox against unrestricted filesystem tools or trusted extensions. [Agent loading](agents.md#prompts-tools-and-resource-loading) owns those limitations.

## Shared storage coordination

`run.resources.files` supplies `readText`, `writeText`, and `withExclusiveLock(path, async lockedPath => ...)`. Standalone callers can construct `NornFileCoordinator({lockRoot, waitTimeoutMs})` from `norn`. Coordinating callers must use the same lock namespace. Target parents must exist before a raw `withExclusiveLock` call; `writeText` creates them. Existing symbolic links resolve to their canonical target; dangling links fail.

The lock spans the complete callback, including read/validate/modify/persist. Atomic replacement remains underneath managed writes. A live owner is never expired by a TTL; confirmed dead local owners can be reclaimed. Invalid or foreign-host ownership fails closed, and contention has a bounded wait. PID reuse can delay reclamation rather than permit two owners. This is a local-filesystem, same-host protocol, not a distributed lock.

Workflow state, event manifests, scheduler-state writes, replaceable artifacts and whole-value logs use this coordination. Scheduler state remains executor-owned. Dedicated command-output streams retain their single-writer protocol; observability reads may see partial live streams. Immutable snapshot objects and run execution leases retain their own protocols. File locks do not make multi-file snapshots or external side effects transactional.

| Decision | GOOD | BAD |
|---|---|---|
| IF updating shared file data, THEN hold one lock around the entire operation and use its canonical `lockedPath`. ELSE ordinary atomic replacement suffices only for independent values. | Read, modify and atomically replace inside one callback. | Lock only the final write after reading stale contents. |
| IF two callers access the same resource, THEN use the same coordinator namespace. ELSE do not claim mutual exclusion. | Reuse the run manager's `files`. | Give each session a different lock root for the same data. |
| IF a callback holds a lock, THEN finish its short storage operation before prompting a model or taking another lock on the same file. ELSE release it first. | Persist a value and return. | Wait for a model turn while holding a file lock. |
| IF restoring a checkpoint, THEN restore resource data but not lock ownership. ELSE follow the owning external resource's recovery contract. | Built-in locks live under the run's `locks/`, outside `current/`. | Restore an old owner's lock directory as live ownership. |

Sources: [resource manager](../src/resources.ts), [adapter contracts](../src/agent-resource-adapter.ts), [StateAdapter](../src/state-adapter.ts), [file coordinator](../src/files.ts).

# Run resources and exclusive locking

## Initialization is separate from attachment

`run.resources` provides shared resource handles. The [shared-state example](../examples/shared-state/README.md) demonstrates mutable storage as a custom resource.

`run.resources.ensure(definition)` returns a shared handle for that resource across workflow contexts in the current executor. A definition contains `name`, `kind`, JSON `configuration`, and `initialize({directory, files, mode})`. Names are single alphanumeric/underscore/hyphen identifiers starting with an alphanumeric character. Identity/configuration conflicts fail; `configuration` owns format/version compatibility.

`mode: "create"` also covers retry of an interrupted initialization; `mode: "open"` means an earlier initialization succeeded. Initializers own their data schema and must reject missing/incompatible data when reopening. Failed initialization remains visible and retryable, not a successful empty resource. Definitions have no filesystem effects until ensured.

| Decision | GOOD | BAD |
|---|---|---|
| IF implementing an initializer, THEN make create retries preserve existing data and open validate existing storage. ELSE do not register the definition. | Validate a file left by an interrupted create before reusing it. | Truncate the file each time `ensure` calls the initializer. |
| IF a resource format changes incompatibly, THEN change its declared configuration and provide an explicit migration. ELSE reopen the same format. | A mismatching `format` fails. | Reinterpret old bytes under an unchanged format declaration. |

[Persistence](persistence.md) covers resource lifetimes, storage locations, and recovery. Cross-run storage, queues, ledgers, and scheduler/agent activation are not supplied by this API.

## Explicit agent attachment

The [shared-state example](../examples/shared-state/README.md) supplies its own resource and permission-selected adapter. The [queue example](../examples/coordinating-multiple-agents/README.md) supplies a different resource and tool contract. Neither adapter is a built-in SDK state facility.

Custom adapters implement `NornAgentResourceAdapter`: a unique name and `bind({runId, label})` returning a `NornAgentResourceBinding` with tools and async `dispose()`. An adapter can expose one or several resource handles; initializing storage does not construct or attach tools. Session creation and one-shot prompting accept adapters through `resourceAdapters`, not through the resource manager or state handle directly. Attached tools are activated with the normal response tool. Duplicate adapter names and collisions with built-ins, the response tool, other adapters or already-loaded extension tools fail. Successful bindings are cleaned up in reverse order on session disposal or later creation failure. An initializer/binder that throws before returning its handle owns cleanup of its partial allocations.

| Decision | GOOD | BAD |
|---|---|---|
| IF a Norn agent needs resource access, THEN attach an adapter exposing the required operations. ELSE omit the attachment. | A reviewer receives read-only access to a candidate. | Automatically expose every resource to every session. |
| IF disposing a binding, THEN release session-local handles only. ELSE retain the resource for later sessions. | Close a subscription. | Delete workflow state when its agent exits. |

The attachment never exposes internal scheduler/checkpoint control state. It is a cooperative tool boundary, not a sandbox against unrestricted filesystem tools or trusted extensions. [Agent loading](agents.md#prompts-tools-and-resource-loading) owns those limitations.

## Shared storage coordination

`run.resources.files` supplies `readText`, `writeText`, and `withExclusiveLock(path, async lockedPath => ...)`. Standalone callers can construct `NornFileCoordinator({lockRoot, waitTimeoutMs})` from `@vimhead.dev/norn`. Coordinating callers must use the same lock namespace. Target parents must exist before a raw `withExclusiveLock` call; `writeText` creates them. Existing symbolic links resolve to their canonical target; dangling links fail.

The lock spans the complete callback, including read/validate/modify/persist. `writeText` replaces complete file contents atomically. A live owner is never expired by a TTL; confirmed dead local owners can be reclaimed. Invalid or foreign-host ownership fails closed, and contention has a bounded wait. PID reuse can delay reclamation rather than permit two owners. Locks support local filesystems on one host, not distributed storage.

Reads of live command-output logs may return partial streams. File locks do not make multi-file snapshots or external side effects transactional.

| Decision | GOOD | BAD |
|---|---|---|
| IF updating shared file data, THEN hold one lock around the entire operation and use its canonical `lockedPath`. ELSE ordinary atomic replacement suffices only for independent values. | Read, modify and atomically replace inside one callback. | Lock only the final write after reading stale contents. |
| IF two callers access the same resource, THEN use the same coordinator namespace. ELSE do not claim mutual exclusion. | Reuse the run manager's `files`. | Give each session a different lock root for the same data. |
| IF a callback holds a lock, THEN finish its short storage operation before prompting a model or taking another lock on the same file. ELSE release it first. | Persist a value and return. | Wait for a model turn while holding a file lock. |
| IF restoring a checkpoint, THEN restore resource data but not lock ownership. ELSE follow the owning external resource's recovery contract. | Built-in locks live under the run's `locks/`, outside `current/`. | Restore an old owner's lock directory as live ownership. |

Sources: [resource contracts](../packages/sdk/src/resources.ts), [resource manager](../packages/cli/src/resources.ts), [adapter contracts](../packages/sdk/src/agent-resource-adapter.ts), [file coordinator](../packages/sdk/src/files.ts).

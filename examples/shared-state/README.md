# Norn agent with explicitly attached state

[Select the matching runtime](../../docs/cli.md#select-the-runtime), copy this directory to a writable task directory, and enter it. This example makes one live model call and requires [Norn agent authentication and a default model](../../docs/providers.md).

```bash
norn workflows inspect sharedState.copy
norn runs start sharedState.copy < input.json
norn runs wait <returned-run-id>
norn runs inspect <returned-run-id>
```

[shared-state.ts](shared-state.ts) defines an example-local resource, opened explicitly with `run.resources.ensure(sharedState)` in each step. Its `get`, `getOptional`, and `set` operations validate field values; missing required values fail, and schema defaults do not initialize fields.

The first workflow writes the source. Its Norn agent receives only read access to the source and write access to the copy through the example's [createStateTools](state-tools.ts) factory. The workflow registers these definitions through `customTools` and selects their names through `tools`, requesting no filesystem task tools. After the agent session closes, a transition checkpoints the values; the next workflow checks exact equality and writes `copy.txt` inside `paths.workspace`. Missing or different output fails instead of trusting the agent's response.

The factory provides `norn_state_list`, `norn_state_get`, and `norn_state_set`. List/get responses page serialized JSON using UTF-16 `offset` and `limit` (1–10000), returning `text`, `nextOffset`, and `revision`. Unset values report `isSet:false`; writes require a granted field and its schema-valid complete value. A separate get followed by set is not a transaction.

| Decision | GOOD | BAD |
|---|---|---|
| IF combining pages, THEN compare revisions and restart when they differ. ELSE treat the page as a fragment. | Re-read a changed value. | Combine pages from different revisions. |

A successful result contains `data.copyPath: "copy.txt"` and `status: completed`. Resolve that path against the inspected `run.paths.workspace` and compare its bytes with the input source. Normal Pi extension/context loading still applies; this is not an OS sandbox.

| Decision | GOOD | BAD |
|---|---|---|
| IF changing the agent's role, THEN select its required fields and permissions explicitly. ELSE retain the existing grants. | Add read access to a new input field. | Attach every stored field to every agent. |
| IF verifying completion, THEN inspect persisted output. ELSE report the run as unverified. | Compare `copy.txt` with the input string. | Accept `copied:true` without reading state. |

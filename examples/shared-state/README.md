# Worker with explicitly attached state

[Select the matching runtime](../../docs/cli.md#select-the-runtime), copy this directory to a writable task directory, and enter it. This example makes one live model call and requires configured Pi authentication and a default model.

```bash
norn workflows inspect sharedState.copy
norn runs start sharedState.copy < input.json
norn runs wait <returned-run-id>
norn runs inspect <returned-run-id>
```

The workflow seeds source state. Its worker receives only read access to the source and write access to the copy through [State tools](../../docs/resources.md). It requests no filesystem task tools. After the worker session closes, a transition checkpoints the values; the next workflow checks exact equality and writes `current/artifacts/copy.txt`. Missing or different output fails instead of trusting the worker's response.

A successful result contains the copy artifact and `status: completed`. Compare its bytes with the input source. Normal Pi extension/context loading still applies; this is not an OS sandbox.

| Decision | GOOD | BAD |
|---|---|---|
| IF changing the worker's role, THEN select its required fields and permissions explicitly. ELSE retain the existing grants. | Add read access to a new input field. | Attach every field because it exists in the manifest. |
| IF verifying completion, THEN inspect persisted output. ELSE report the run as unverified. | Compare `copy.txt` with the input string. | Accept `copied:true` without reading state. |

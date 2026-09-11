# CLI and client

## Select the runtime

[Install Norn](../README.md#installation), then inspect the executable you will actually invoke:

```bash
command -v norn
norn version
norn help
```

For a source checkout, after installing its dependencies, a shell function keeps all examples bound to that checkout rather than another `PATH` installation:

```bash
NORN_ROOT=/absolute/path/to/norn
norn() { node "$NORN_ROOT/bin/norn.mjs" "$@"; }
norn version
```

Use Node satisfying the package's engine requirement (currently `>=22.19.0`). `NORN_ROOT` here is an example shell variable, not a runtime configuration option. The npm package ships `docs/`, `examples/`, and `src/`; a standalone release binary does not itself provide a local documentation directory. Match any accompanying checkout/docs to its reported build revision. Source builds may not carry release revision metadata.

Copied examples already contain a project file, so they skip initialization. npm
omits `.gitignore` from the package; add `.norn/runs/` to the copy's `.gitignore`
before committing example work. Source-checkout examples include that exclusion.

## Discover live contracts

```bash
norn project inspect
norn workflows list
norn workflows list --all
norn workflows inspect <workflow-id>
norn commands list
norn commands inspect runs.start
norn help runs start
```

Default workflow listing shows entrypoints; `--all` includes internal steps. Workflow inspection returns instructions, params JSON Schema, isolation, gate metadata and plugin source locations. [Loading diagnostics](projects.md#diagnose-registration) are part of the discovery envelope.

Help is text; ordinary results are JSON. `runs logs` emits JSONL events. Commands and schemas from the invoked executable are authoritative when a checkout and installation differ.

## Start, wait, inspect

From inside the target project:

```bash
printf '%s\n' '{"params":{"name":"Ada"}}' | norn runs start greeting.write
norn runs wait <run>
norn runs inspect <run>
norn runs metrics <run>
```

Start returns `{ "run": ... }` with `id`, `name`, and `path`, after launching a detached executor. This is acceptance of the launch, not success of the task. `runs wait` returns when the run is no longer running or inspection reports it unhealthy. Its successful process exit does not mean the workflow completed; callers check `run.status`, `run.health`, and outcome/failure information.

A completed capability's outputs are in `run.outcome.metadata`. Artifact refs resolve beneath `<run.path>/current/artifacts/`. The [minimal example](../examples/minimal-workflow/README.md) gives concrete output expectations.

Start stdin accepts `params` and optional `config`, with config overrides keyed by plugin ID. Params are JSON, not CLI flags or TOON. For display, a JSON viewer can format a finite result; keep machine artifacts and JSONL events in their native format.

| Decision | GOOD | BAD |
|---|---|---|
| IF start returns a run ID, THEN retain it and inspect the terminal outcome. ELSE handle the launch error. | Wait, then verify `status === "completed"` and expected artifact content. | Report task success from `runs start` alone. |
| IF a new capability is written or registered, THEN query the current catalogue and schema. ELSE use the inspected contract. | `workflows inspect greeting.write` after editing. | Rely on a cached session-start list that cannot contain the new workflow. |

For live monitoring and explicit lifecycle control:

```bash
norn runs list
norn runs logs <run>
norn runs logs <run> --follow
norn runs stop <run>
norn runs kill <run>
norn runs delete <run>
```

`stop` signals SIGTERM; `kill` signals SIGKILL. Delete removes an inactive run and its evidence. Neither stopping nor deleting undoes external effects. Resume and rollback are documented in [recovery](recovery.md).

## JavaScript client and other harnesses

```ts
import { createNornClient } from "norn/client";

const client = createNornClient({ spawnCwd: "/absolute/path/to/project" });
const started = await client.runs.start({
  workflowId: "greeting.write",
  params: { name: "Ada" },
});
const finished = await client.runs.wait(started.id);
if (finished.status !== "completed" || finished.health !== "healthy") {
  throw new Error(`Run ${finished.id}: ${finished.status} (${finished.health})`);
}
console.log(finished.outcome?.metadata);
```

The client defaults to its own package's `bin/norn.mjs`. Its optional `executablePath` is a script launched through `process.execPath`, not an arbitrary standalone binary or shell command. Other languages can invoke the CLI directly with cwd, JSON stdin, and parsed stdout.

`workflows.list()` and `inspect()` use fresh CLI discovery. `workflows.entries()` and `client.state` use a cached in-process project load; that state is registration memory, not a chosen run's persisted state. A new client is needed to refresh that in-process catalogue after source edits.

Sources: [CLI declarations and handlers](../src/cli.ts), [client API](../src/client.ts).

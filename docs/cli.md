# CLI and client

## Select the runtime

[Install Norn](../README.md#installation), then inspect the executable you will actually invoke:

```bash
command -v norn
norn version
norn help
```

For a source checkout, run `pnpm install --frozen-lockfile` and `pnpm build` first. A shell function keeps all examples bound to that checkout rather than another `PATH` installation:

```bash
NORN_ROOT=/absolute/path/to/norn
norn() { node "$NORN_ROOT/packages/cli/bin/norn.mjs" "$@"; }
norn version
```

Use Node satisfying the package's engine requirement (currently `>=22.19.0`). `NORN_ROOT` here is an example shell variable, not a runtime configuration option. Use `norn docs inspect` to locate this installation's documentation and examples;
[local documentation assets](#local-documentation-assets) covers binary extraction.
Source builds may not carry release revision metadata. Rebuild after changing source or documentation.

Registry installations update through the package manager in their existing scope:
`npm install -g @vimhead.dev/norn-cli@tip` for a global npm installation, or the
corresponding local install command. `norn upgrade` does not guess that scope.
Standalone binaries retain their checksum-verified `norn upgrade` command.

Copied examples already contain a project file, so they skip initialization. npm
omits `.gitignore` from the package; add `.norn/runs/` to the copy's `.gitignore`
before committing example work. Source-checkout examples include that exclusion.

## Local documentation assets

```bash
norn docs inspect
```

This explicit command works outside a Norn project and does not use the network.
Its `documentation` result contains `storage`, `version`, `commit`, `assetDigest`,
and absolute `paths` (`root`, `readme`, `index`, `docs`, `examples`).

npm/source installations resolve their built `assets/` tree directly from the CLI
package, not the current directory or another executable on PATH. A version mismatch
fails rather than advertising another build's documentation. Compiled binaries embed the docs,
examples, and source references, preserving relative links. The first
inspection makes a complete copy available in a build/content-specific
cache; later calls verify and reuse it without rewriting files. Different asset
contents or build commits use separate entries. `version` and help do not extract
anything. No prompt augmentation or agent-context delivery is performed.

Cache roots:

- macOS: `~/Library/Caches/norn/docs/`
- Linux: `$XDG_CACHE_HOME/norn/docs/`, or `~/.cache/norn/docs/`
- Windows: `%LOCALAPPDATA%/norn/docs/`, or `~/AppData/Local/norn/docs/`
- Explicit override: `NORN_DOCS_CACHE_DIR`

Existing cache entries must match the bundled files exactly, with no missing or
extra files or symlinks. Corrupt entries are not silently overwritten; the error
names the entry to remove before retrying.
This is accidental-corruption detection, not a sandbox against another process
with access to the same user's cache. Old build entries are not automatically
removed. The extracted tree is a documentation snapshot, not a separate runtime
installation.

| Decision | GOOD | BAD |
|---|---|---|
| IF an example will be edited or run, THEN copy it into the task workspace first. ELSE read the cached asset in place. | Copy `paths.examples/minimal-workflow` before starting a run. | Modify the verified cache or put `.norn/` state inside it. |
| IF inspection reports a modified/incomplete cache, THEN preserve any wanted edits elsewhere, remove only the named cache entry, and retry. ELSE reuse the returned paths. | Remove the reported `v1-...` directory after preserving work. | Delete every build's cache or accept modified docs as matching the binary. |

The same resolver is available from [`@vimhead.dev/norn-cli/documentation`](../packages/cli/src/documentation.ts),
with explicit source, build metadata, and cache-root inputs.

## Documentation introduction

```bash
norn docs intro
```

Returns `{ "intro": "..." }`: a compact authoring introduction with runtime
version/commit, invocation, and pointers to the documentation index and examples.
Topic routing remains in the index; the command does not copy manuals or enumerate
workflows. It returns locations for the same installed documentation as `docs inspect`
and works without a valid project.

The invocation is a JSON argument array, not a shell command string. Its first
entry is the executable; remaining entries precede CLI arguments. Source/npm
invocations include the Node executable and this installation's `bin/norn.mjs`;
compiled invocations contain the binary path. Spaces and quotes remain part of
each argument, without relying on another `norn` installation on PATH.

`renderNornDocumentationIntro({ documentation, invocation })`, also exported from
[`@vimhead.dev/norn-cli/documentation`](../packages/cli/src/documentation.ts), renders the same text from explicit
inputs without filesystem or process access. Generating the introduction does not
inject it into prompts or alter Norn agent sessions.

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

Default workflow listing shows entrypoints; `--all` includes internal steps. Workflow inspection returns instructions, args JSON Schema, gate metadata, workflow/scope configuration schemas and keys, and registration source locations. [Loading diagnostics](projects.md#diagnose-registration) are part of the discovery envelope.

Help is text; ordinary results are JSON. `runs logs` emits JSONL events.
`norn pi [arguments...]` is a passthrough to bundled Pi, preserving Pi's native
output and exit status rather than wrapping them in Norn JSON. Use `norn pi --help`
for Pi's options and [provider setup](providers.md) for operator instructions.
Commands and schemas from the invoked executable are authoritative when a checkout and installation differ.

## Start, wait, inspect

From inside the target project:

```bash
printf '%s\n' '{"args":{"name":"Ada"}}' | norn runs start greeting.write
norn runs wait <run>
norn runs inspect <run>
norn runs metrics <run>
```

Start returns `{ "run": ... }` with `id`, `name`, and `path`, after launching a detached executor. This is acceptance of the launch, not success of the task. `runs wait` returns when the run is no longer running or inspection reports it unhealthy. Its successful process exit does not mean the workflow completed; callers check `run.status`, `run.health`, and outcome/failure information.

A completed capability's outputs are in `run.outcome.metadata`. Artifact refs resolve beneath `<run.path>/current/artifacts/`. The [minimal example](../examples/minimal-workflow/README.md) gives concrete output expectations.

Start stdin accepts `args` and optional `config`, with config overrides keyed independently by workflow ID or scope ID. Args are JSON, not CLI flags or TOON. For display, a JSON viewer can format a finite result; keep machine artifacts and JSONL events in their native format.

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

Claude Code, Pi, Codex, and other CLI-capable harnesses can invoke Norn without an
adapter. Workflows provide portable task delegation and workflow logic, not
compatibility with a host's plugin format or UI extension APIs. The caller does
not need Pi installed: [Norn agents](agents.md) use Norn's bundled Pi runtime.

The JavaScript client invokes the runtime; the [Norn SDK](workflows.md) defines
workflows. For example, start and inspect a run through `@vimhead.dev/norn-cli/client`:

```ts
import { createNornClient } from "@vimhead.dev/norn-cli/client";

const client = createNornClient({ spawnCwd: "/absolute/path/to/project" });
const started = await client.runs.start({
  workflowId: "greeting.write",
  args: { name: "Ada" },
});
const finished = await client.runs.wait(started.id);
if (finished.status !== "completed" || finished.health !== "healthy") {
  throw new Error(`Run ${finished.id}: ${finished.status} (${finished.health})`);
}
console.log(finished.outcome?.metadata);
```

The client defaults to its own package's `bin/norn.mjs`. Its optional `executablePath` is a script launched through `process.execPath`, not an arbitrary standalone binary or shell command. Other languages can invoke the CLI directly with cwd, JSON stdin, and parsed stdout.

`workflows.list()` and `inspect()` use fresh discovery. `workflows.entries()` retains its loaded catalogue; create a new client to refresh those entries after source edits.

Sources: [CLI declarations and handlers](../packages/cli/src/cli.ts), [client API](../packages/cli/src/client.ts).

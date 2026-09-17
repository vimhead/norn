# Projects and loading

## Create and register

```bash
norn project init
```

Initialization creates `norn.project.json`, `.norn/runs/`, and a run-state exclusion in `.gitignore`. Project discovery walks upward from the invocation directory to the nearest `norn.project.json`.

A plugin can be a single file anywhere explicitly registered by the project:

```json
{
  "version": 1,
  "plugins": ["./workflows/plugin.ts"],
  "config": {
    "example": { "repositoryRoot": "." }
  }
}
```

`config` is keyed by plugin ID and validated against that plugin's manifest schema. Omit the entry for a plugin with no config schema. [The minimal example](../examples/minimal-workflow/README.md) needs only its project file and plugin.

Reusable config files, conventionally `norn.json`, can declare `plugins`, `includes`, and `config`. The project includes them explicitly:

```json
{
  "version": 1,
  "plugins": ["./local-plugin.ts"],
  "includes": ["./packages/*/norn.json"]
}
```

Plugin and include paths resolve relative to the file declaring them. `*` matches one directory segment. There is no automatic plugin tree scan, nor automatic inclusion of a sibling `norn.json`. Project config overrides included values; conflicting reusable values and duplicate plugin IDs are rejected. `version` and `seerMode` belong only in the project file.

Projects using Seer can additionally declare writable project-relative roots:

```json
"seerMode": { "writableRoots": ["./workflow-sources"] }
```

This is a project-file field, not an OS sandbox. The current helper contract is in
[Seer exports](../src/seer/index.ts) and [config resolution](../src/seer/config.ts).

## Import and reload

Each registered module default-exports `definePlugin(manifest, implementation)`. Norn loads TypeScript through jiti without a local build, supplying runtime imports for `norn`, `norn/api`, `norn/schema`, `norn/seer`, `zod`, and `typebox`. Other dependencies need normal package resolution from the plugin's location.

Runtime virtual imports do not configure TypeScript or an editor. An npm-installed matching Norn package provides the SDK types; the source checkout's examples are checked by its `tsconfig.json`. A successful runtime import alone is not a type check.

New CLI discovery/start/resume invocations load current source; an already executing workflow retains its loaded implementation. Module evaluation and implementation factories run even during discovery. Factory context state is in-memory registration state, **not** durable run state; see [persistence](persistence.md).

| Decision | GOOD | BAD |
|---|---|---|
| IF source changes, THEN inspect it through a new invocation before starting or resuming. ELSE use the inspected declaration. | Edit `plugin.ts`, run `workflows inspect`, then resume. | Assume a running Norn agent or executor hot-reloads the edit. |
| IF importing a plugin can mutate files or start work, THEN move those effects into workflow execution. ELSE keep import-time declarations and factory construction. | `execute` launches the command. | `workflows list` unexpectedly starts a delivery from top-level module code. |

## Diagnose registration

```bash
norn project inspect
norn workflows list --all
norn workflows inspect example.plan
```

Discovery returns `isComplete` and `diagnostics`. Each diagnostic includes source paths, stage, message, and schema issues when available. A broken plugin is excluded as a whole; duplicate plugin IDs exclude all conflicting sources. `import` covers module evaluation as well as syntax/import errors.

Discovery can exit successfully with an incomplete catalogue. Start, resume, and executable client entries require the entire project to load; otherwise they report `NORN_PROJECT_INVALID`. Malformed project/include configuration remains fatal rather than producing a partial catalogue.

| Decision | GOOD | BAD |
|---|---|---|
| IF `isComplete` is false, THEN repair or explicitly remove the reported invalid registration and inspect again. ELSE select from the loaded contracts. | Fix the named config field or missing default export. | Treat a listed valid sibling as permission to launch an invalid project. |

Sources: [loader](../src/plugin-loader.ts), [registry](../src/internal/workflow-registry.ts). Next: [write a workflow](workflows.md), [reuse across projects](composition.md).

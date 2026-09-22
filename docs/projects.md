# Projects and loading

## Create and register

```bash
norn project init
```

Initialization creates `norn.project.json`, `.norn/runs/`, and a run-state exclusion in `.gitignore`. Project discovery walks upward from the invocation directory to the nearest `norn.project.json`.

Register workflow modules explicitly:

```json
{
  "version": 1,
  "workflows": ["./workflows/index.ts"]
}
```

Each module default-exports an array of complete [workflow definitions](workflows.md):

```ts
import { summarize } from "./summarize.ts";
import { save } from "./save.ts";

export default [summarize, save];
```

Arrays may contain standalone workflows and workflows from multiple scopes. Only array entries are registered; importing or calling a target does not register it. Include internal transition targets as well as entrypoints. The [minimal example](../examples/minimal-workflow/README.md) needs only its project file and workflow module.

The optional `config` object contains independently keyed [workflow and scope configuration](workflows.md#shared-scopes-and-configuration). Omit entries for owners without a config schema.

Reusable config files, conventionally `norn.json`, can declare `workflows`, `includes`, and `config`:

```json
{
  "version": 1,
  "workflows": ["./local-workflows.ts"],
  "includes": ["./packages/*/norn.json"]
}
```

Workflow and include paths resolve relative to the file declaring them. `*` matches one directory segment. There is no automatic workflow tree scan or inclusion of a sibling `norn.json`. Project config overrides included values; conflicting reusable values are rejected. `version` belongs only in the project file.

Workflow IDs must be unique. Workflows can share a scope across modules by importing one scope definition; independent declarations of the same scope ID conflict.

## Import and reload

TypeScript modules need no local build. Runtime imports are supplied for `@vimhead.dev/norn`, its `/files` and `/schema` subpaths, `typebox`, `typebox/value`, `typebox/compile`, and `typebox/schema`. Other dependencies need normal package resolution from the workflow module's location.

Runtime imports do not configure TypeScript or an editor. A matching `@vimhead.dev/norn` installation provides SDK types; the source checkout's examples are checked by its `tsconfig.json`. A successful runtime import alone is not a type check.

New CLI discovery/start/resume invocations load current source; an already executing workflow retains its loaded definition. Discovery does not invoke workflow execution or gate descriptions. Module-level code still executes during import.

| Decision                                                                                                                                  | GOOD                                      | BAD                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------- |
| IF source changes, THEN inspect it through a new invocation before starting or resuming. ELSE use the inspected definition.               | Edit a workflow, inspect it, then resume. | Assume a running executor hot-reloads edits.            |
| IF importing a module can mutate files or start work, THEN move those effects into workflow execution. ELSE keep import-time definitions. | `execute` launches the command.           | `workflows list` starts a delivery from top-level code. |

## Diagnose registration

```bash
norn project inspect
norn workflows list --all
norn workflows inspect example.plan
```

Discovery returns `isComplete` and `diagnostics`, with source paths, stage, message, and schema issues when available. An invalid registration module is excluded as a whole; conflicting workflow IDs or scope declarations exclude the conflicting modules. `import` covers module evaluation as well as syntax/import errors.

Workflow inspection exposes argument and configuration schemas, separate workflow/scope config keys, and the registration module and declaring configuration file. The registration module is not necessarily the file containing the implementation.

Discovery can exit successfully with an incomplete catalogue. Start, resume, and executable client entries require the entire project to load; otherwise they report `NORN_PROJECT_INVALID`. Malformed project/include configuration is fatal rather than producing a partial catalogue.

| Decision                                                                                                                                      | GOOD                                          | BAD                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------- |
| IF `isComplete` is false, THEN repair or explicitly remove the invalid registration and inspect again. ELSE select from the loaded contracts. | Fix the named config field or default export. | Launch a valid sibling from an incomplete project. |

Next: [write a workflow](workflows.md), [reuse across projects](composition.md).

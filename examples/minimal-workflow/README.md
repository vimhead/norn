# Create → run → change a workflow

This code-driven example needs no model, credentials, dependencies in the example
directory, or compilation step. It writes a greeting artifact and exposes its text
in the run outcome.

## Create and register

First [select the matching Norn runtime](../../docs/cli.md#select-the-runtime).
Copy this directory into a writable task directory and `cd` into the copy. Its
entire capability consists of:

- [plugin.ts](plugin.ts): manifest, params schema, and implementation.
- [norn.project.json](norn.project.json): explicit plugin registration.

For a project you already have, copy just the plugin and add its path to that
project's `plugins` array rather than replacing the project configuration.

## Inspect and run

```bash
norn project inspect
norn workflows list
norn workflows inspect greeting.write
printf '%s\n' '{"params":{"name":"Ada"}}' | norn runs start greeting.write
```

Discovery should report `isComplete: true`. Inspection describes the required
`name` string; the workflow appears as an entrypoint.

Copy `run.id` from start into a shell variable:

```bash
RUN=<returned-run-id>
norn runs wait "$RUN"
norn runs inspect "$RUN"
```

Expected outcome: `run.status` is `completed`,
`run.outcome.metadata.data.greeting` is `Hello, Ada!`, and
`run.outcome.metadata.artifacts.greeting` is `{ "path": "greeting.txt" }`.
Read `.norn/runs/$RUN/current/artifacts/greeting.txt` to verify the saved content.

## Change and re-exercise

In your copied `plugin.ts`, change:

```ts
const greeting = `Hello, ${params.name}!`;
```

to:

```ts
const greeting = `Welcome, ${params.name}!`;
```

Run inspection and start again with the same input, then wait on the **new** run
ID. The new outcome/artifact should say `Welcome, Ada!`; the first run still
contains `Hello, Ada!`. No rebuild or Norn reload command is needed.

Starting with `{"params":{"name":" "}}` should fail parameter validation rather
than launch useful work. This tests the declaration, not only the happy-path
implementation.

## Retain the capability

The copied source and registration are the reusable capability. Another caller
can supply a different name through the same entrypoint. Commit those source
files when wanted, not `.norn/runs/`. For caller-selected continuations rather
than independent runs, see [composition](../../docs/composition.md).

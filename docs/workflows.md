# Workflow authoring with the Norn SDK

The Norn SDK is the TypeScript interface for building reusable workflows. A workflow can execute code and commands, delegate work to [Norn agents](agents.md), or combine both. Norn is the runtime that runs those workflows; the [CLI and client](cli.md) expose its lifecycle. Import authoring APIs from `@vimhead.dev/norn`; `@vimhead.dev/norn-cli` supplies the runtime. [Installation](../README.md#build-workflows-with-the-norn-sdk) covers SDK types and version matching.

Start with the complete [minimal workflow](../examples/minimal-workflow/plugin.ts) and its [write/run/change exercise](../examples/minimal-workflow/README.md).

## Define a workflow

`workflow` declares a complete, typed callable workflow:

```ts
import { workflow } from "@vimhead.dev/norn";
import { Type } from "typebox";

export const greet = workflow({
  name: "greet",
  isEntrypoint: true,
  instructions: "Return a greeting for the supplied name.",
  args: Type.Object({ name: Type.String() }),
  execute({ args, run }) {
    return run.complete({ summary: `Hello, ${args.name}!` });
  },
});

export default [greet];
```

Supply `name`, `args`, `isEntrypoint`, and `execute` explicitly. Entrypoints need nonempty caller-facing `instructions`; internal steps may omit them. `isEntrypoint` controls default catalogue visibility, not authorization: the CLI can start a known internal workflow ID directly.

Workflow and scope names must be nonempty and cannot contain dots. A standalone workflow's ID is its name; a scoped workflow's ID is `<scope name>.<workflow name>`. Declarations expose the resolved `id`; CLI commands, references, and `run.next` use that exact ID, without implicit scope lookup.

`instructions` describe selection, inputs, effects, and outputs. They are neither a Norn agent system prompt nor a gate decision. Declare args and config with [TypeBox schemas](schemas.md). Workflow inputs must be JSON data; `execute` receives the values after schema defaults and conversions. Public schemas must support `workflows inspect`.

Destructure the properties needed by the step from `execute(context)`. Gate descriptions receive the same inferred context:

| Property | Value |
|---|---|
| `args` | Decoded invocation arguments |
| `config` | Decoded workflow-local configuration, or `undefined` without a schema |
| `scope` | `{ id, config }` for scoped workflows; the property is absent for standalone workflows |
| `paths` | Absolute `project` and `workspace` directories; see [filesystem boundaries](persistence.md#filesystem-boundaries) |
| `agents` | `prompt` and `createSession`; see [Norn agents](agents.md) |
| `commands` | `run` for recorded command execution |
| `logs` | `read(logRef)` for recorded output |
| `run` | Run identity (`id`) and control (`next`, `complete`, `fail`) |

Helpers can accept `NornAgents`, `NornCommands`, or `NornLogs` from the SDK when they need only that capability.

Execution returns one control result:

| Control | Meaning |
|---|---|
| `target(args)` / `args.next(contribution)` | Select a known workflow or a caller-supplied next step. See [composition](composition.md). |
| `run.next(workflowId, args)` | Select a workflow by string ID; its input is checked at execution. |
| `run.complete(metadata)` | Complete the whole run, optionally exposing `summary`, `logs`, and `data`. |
| `run.fail({ summary, ...metadata })` | Record failure with an actionable explanation and optional evidence. |

Throwing also fails execution. Neither a Norn agent returning text nor writing a file completes the run. Outcome `data` has no workflow-specific result schema enforced by Norn: the capability must define and validate its own result contract.

| Decision | GOOD | BAD |
|---|---|---|
| IF a required outcome was prevented, THEN return failure or reach an explicitly declared gate. ELSE complete with evidence for the actual outcome. | Delivery failure retains assessment refs and reports the delivery error. | A completed wrapper whose separate coordinator still has required work pending. |
| IF a helper only transforms data, THEN keep it an ordinary function. ELSE use a workflow boundary when control and recovery must be retained. | Local label normalization inside a persisted assessment step. | A workflow transition for each string operation. |

## Shared scopes and configuration

A scope gives workflows a namespace and optional shared configuration. Each workflow can also declare its own configuration:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { workflowScope } from "@vimhead.dev/norn";
import { Type } from "typebox";

export const reports = workflowScope({
  name: "reports",
  config: Type.Object({ path: Type.String() }),
});

export const save = reports.workflow({
  name: "save",
  isEntrypoint: false,
  args: Type.Object({ text: Type.String() }),
  config: Type.Object({ filename: Type.String() }),
  async execute({ args, config, scope, paths, run }) {
    const reportPath = join(paths.workspace, scope.config.path, config.filename);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, args.text);
    return run.complete({ data: { reportPath } });
  },
});
```

The workflow ID is `reports.save`. Configuration uses separate keys:

```json
{
  "config": {
    "reports": { "path": "reports" },
    "reports.save": { "filename": "summary.txt" }
  }
}
```

`config` and `scope.config` are independently validated; neither inherits or overrides the other. Run overrides use the same keys and merge into each owner's encoded configuration before decoding. A scope without a config schema supplies `scope.config` as `undefined`.

Workflows in different files share a scope by importing one scope definition. Independently declaring the same scope ID is an error, even with identical schemas. Workflow IDs must be unique, and a workflow ID cannot also belong to a scope. [Registration](projects.md) is explicit; declaring or importing a workflow does not register it.

## Recursive transitions

For a workflow that references itself, annotate the execution return type with `WorkflowResult` (or `Promise<WorkflowResult>` for async execution). Context properties remain inferred:

```ts
import { workflow, type WorkflowResult } from "@vimhead.dev/norn";
import { Type } from "typebox";

const repeat = workflow({
  name: "repeat",
  isEntrypoint: false,
  args: Type.Object({ remaining: Type.Integer() }),
  execute({ args, run }): WorkflowResult {
    return args.remaining > 0
      ? repeat({ remaining: args.remaining - 1 })
      : run.complete();
  },
});
```

## Commands

`commands.run` requires an absolute `cwd`, accepts a shell string or an executable/argument tuple, records stdout/stderr logs, and returns exit status and bounded output tails:

```ts
const verification = await commands.run({
  label: "verify",
  cwd: paths.project,
  command: ["npm", "test"],
  timeoutMs: 120_000,
});
if (verification.exitCode !== 0) {
  return run.fail({
    summary: "Verification failed; inspect the command logs before retrying.",
    logs: { stdout: verification.stdoutLog, stderr: verification.stderrLog },
  });
}
return run.complete({ summary: "Verification passed." });
```

Use `logs.read(verification.stdoutLog)` to read the recorded stdout. This fragment checks the project in place. To check a prepared copy instead, supply its absolute directory as `cwd`; see [workspace setup](persistence.md#filesystem-boundaries).

| Decision | GOOD | BAD |
|---|---|---|
| IF command success is required, THEN check `exitCode` and retain relevant log refs. ELSE interpret nonzero status according to that command's contract. | `npm test` exit 1 causes `run.fail`. | Assume a nonzero command automatically fails the workflow. |
| IF command arguments include untrusted values, THEN pass an executable/argument tuple or validate the shell input. ELSE use a shell string for intentional shell syntax. | `["git", "show", validatedRevision]`. | Interpolate arbitrary source text into a shell command. |

The scheduler executes one workflow at a time (at most 1,000 steps). Ordinary TypeScript concurrency is available inside a step; shared-file writes and effect ordering still need explicit coordination. For agent orchestration, [Norn agent sessions](agents.md) expose agent lifecycle within the run rather than an independently managed coordinator.

Sources: [Norn SDK public types and API](../packages/sdk/src/api.ts), [execution registry](../packages/cli/src/internal/workflow-registry.ts), [commands](../packages/cli/src/internal/commands.ts), [scheduler](../packages/cli/src/internal/engine.ts).

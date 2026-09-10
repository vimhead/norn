# norn

Reusable, harness-agnostic workflows powered by Pi agents.

Norn lets a project package agent workflows once and run them from any harness
that can call the Norn CLI or client. Workflows combine Pi agent calls, shell
commands, artifacts, state, gates, checkpoints, and resume into one reusable
project capability.

Contents:

- [Installing the agent skill](#installing-the-agent-skill)
- [Setting up a Norn project](#setting-up-a-norn-project)
- [Writing workflows](#writing-workflows)
- [Using the CLI](#using-the-cli)
- [Development](#development)

## Installing the agent skill

The [norn skill](skills/norn/SKILL.md) teaches agents to create, use, compose, and
repair workflows while solving a task. Install it with the Skills CLI:

```bash
npx skills add vimhead/norn --skill norn
```

List available skills without installing:

```bash
npx skills add vimhead/norn --list
```

This installs the skill, not the Norn runtime. Install the CLI separately below;
no Pi integration extension is required. The skill follows the Agent Skills
standard and lives in `skills/norn/SKILL.md` alongside the runtime source.

## Setting up a Norn project

Install the CLI from the rolling `tip` release:

```bash
curl -fsSL https://github.com/vimhead/norn/releases/download/tip/install.sh | sh
norn version
```

Use `NORN_INSTALL_DIR` when the binary should be installed somewhere other than
`~/.local/bin`:

```bash
curl -fsSL https://github.com/vimhead/norn/releases/download/tip/install.sh | NORN_INSTALL_DIR=/usr/local/bin sh
```

You can also install from GitHub with npm:

```bash
npm install github:vimhead/norn
# or
npm install -g github:vimhead/norn
```

Create a project:

```bash
norn project init
```

This creates a self-contained `norn.project.json` and `.norn/runs/`. Norn finds a
project by walking up to the nearest `norn.project.json`.

Register plugins directly in the project file; no separate `norn.json` is needed:

```json
{
  "version": 1,
  "plugins": ["./plugin.ts"],
  "config": {
    "example": {
      "repositoryRoot": "."
    }
  }
}
```

`norn.project.json` supports `plugins`, `includes`, and `config`, plus the
project-only `version` and `seerMode` fields. Plugin paths are resolved relative
to the file that declares them, not the invoking directory. Config is keyed by
plugin id and validated by the plugin manifest.

Optional reusable configuration files, conventionally named `norn.json`, can
contribute plugins, includes, and shared config:

```json
{
  "plugins": ["./plugin.ts"]
}
```

Include reusable configs explicitly, alongside any project-local plugins:

```json
{
  "version": 1,
  "plugins": ["./plugin.ts"],
  "includes": ["./packages/*/norn.json"]
}
```

`*` matches one directory segment. Initialization does not automatically include
an existing sibling `norn.json`, and Norn does not scan the tree for plugins.
Project config overrides included values; conflicting values between reusable
configs and duplicate plugin ids are rejected.

Projects that use Seer mode can declare writable project-relative roots:

```json
{
  "version": 1,
  "plugins": ["./plugin.ts"],
  "seerMode": {
    "writableRoots": ["./workflow-sources"]
  }
}
```

Inspect the resolved project before running workflows:

```bash
norn project inspect
norn workflows list
```

Discovery commands (`project inspect`, `workflows list`, `workflows inspect`)
return `isComplete` and `diagnostics` alongside their results. A broken plugin
is excluded as a whole; duplicate plugin IDs exclude all conflicting sources.
Diagnostics identify the declaring config, plugin path, failure stage, and error,
with field-level issues for schema validation. The `import` stage includes module
evaluation, not just syntax errors.

An incomplete catalog can still describe successfully loaded workflows; it does
not authorize execution. Start, resume, and executable client entries require the
entire project to load and report `NORN_PROJECT_INVALID` with all collected plugin
diagnostics otherwise. Discovery exits successfully even for incomplete results;
invalid project/include configuration remains fatal. Importing plugins and calling
implementation factories still executes trusted project code, not a sandbox.

The client preserves these result envelopes: `project.inspect()` returns
`{ project, isComplete, diagnostics }`, `workflows.list()` returns
`{ workflows, isComplete, diagnostics }`, and `workflows.inspect()` returns
`{ workflow, isComplete, diagnostics }`. An unavailable workflow in an incomplete
catalog is `null`, rather than falsely asserting that its ID does not exist.

## Writing workflows

A workflow declares params, entrypoint visibility, caller-facing `instructions`,
and an optional isolation mode. Entrypoints require nonempty instructions;
internal steps may omit them. Instructions guide selection and use, not worker
system prompts or gate decisions. Workflow IDs identify and sort catalog entries.

```ts
import { z } from "zod";
import type { NornWorkflowDefinition } from "norn";

export const planWorkflow = {
  instructions: "Use to create an implementation plan for a coding task.",
  isEntrypoint: true,
  params: z.object({ task: z.string() }),
} as const satisfies NornWorkflowDefinition;
```

A manifest gives the plugin an id, binds workflow declarations, and can define
state shared between workflow steps:

```ts
import { definePluginManifest, artifactRefSchema } from "norn";
import { z } from "zod";
import { planWorkflow } from "./workflows/plan.ts";

export const manifest = definePluginManifest({
  id: "example",
  config: z.object({ repositoryRoot: z.string() }),
  workflows: {
    plan: planWorkflow,
  },
  states: {
    planning: {
      planArtifact: artifactRefSchema,
    },
  },
});
```

A plugin binds each manifest workflow to an implementation:

```ts
import { definePlugin } from "norn";
import { manifest } from "./manifest.ts";

export default definePlugin(manifest, {
  workflows: {
    plan: {
      async execute(run, params, config) {
        const status = await run.commands.run({
          label: "status",
          cwd: run.path(config.repositoryRoot),
          command: "git status --short",
        });

        const plan = await run.artifacts.write("plan.md", params.task);
        await run.state.set(manifest.states.planning.planArtifact, plan);

        return run.complete({
          summary: "Plan created.",
          artifacts: { plan },
          logs: { status: status.stdoutLog },
        });
      },
    },
  },
});
```

Workflow implementations return run controls instead of calling other workflows
directly:

```ts
return run.complete({ summary: "Accepted after review." });

return run.fail({ summary: "Blocked by missing credentials." });
```

### Chaining workflows

Use `run.next(...)` to continue with another workflow. Pass a workflow declaration
when the target is known in code:

```ts
return run.next(manifest.workflows.implement, {
  task: params.task,
  iteration: 1,
});
```

A reusable workflow can receive a next step. Its caller supplies opaque
`forwardParams`, which the reusable workflow must spread into `run.next(...)`.
The `params` schema describes the values it contributes. Inspection exposes it
as `x-norn-workflow-ref.contributedParamsSchema` on the reference's JSON Schema
node, alongside the existing reference and open-ended `forwardParams` schema.
The annotation is a standalone input JSON Schema, not additional required fields
in the caller's reference payload; it does not change validation or merging:

```ts
import { artifactRefSchema, workflowRefSchema } from "norn";
import { z } from "zod";

const planningParamsSchema = z.object({
  task: z.string(),
  next: workflowRefSchema({
    params: z.object({
      planArtifact: artifactRefSchema,
      summary: z.string(),
    }),
  }).nullable(),
});

return params.next
  ? run.next(params.next.workflow, {
      ...params.next.forwardParams,
      planArtifact,
      summary,
    })
  : run.complete({ summary, artifacts: { plan: planArtifact } });
```

Caller side:

```ts
return run.next(reusableManifest.workflows.plan, {
  task: params.task,
  next: {
    workflow: projectManifest.workflows.implement,
    forwardParams: { task: params.task },
  },
});
```

Use the default `runWorkspace` isolation for workflows that should operate inside
a per-run workspace. Use `project` isolation only for workflows that must inspect
or verify files in the project root:

```ts
export const verifyWorkflow = {
  instructions: "Use to run project verification.",
  isEntrypoint: true,
  isolation: { mode: "project" },
  params,
} as const satisfies NornWorkflowDefinition;
```

Workflow agents can use dedicated system prompts when a step needs a strict role
such as read-only review:

```ts
const review = await run.agents.prompt({
  label: "review",
  cwd: repositoryPath,
  tools: ["read", "grep", "find", "ls", "bash"],
  systemPrompt: "You are a read-only reviewer. Do not edit files.",
  prompt: "Review the current diff from scratch.",
  response: reviewResponseSchema,
});
```

A gate pauses before a workflow and lets selected top-level params be edited
before execution:

```ts
export const reviewWorkflow = {
  instructions: "Use to approve, revise, or block a proposed change.",
  isEntrypoint: false,
  gate: {
    enabled: true,
    fields: ["decision", "notes"] as const,
  },
  params: reviewParamsSchema,
} as const satisfies NornWorkflowDefinition;
```

## Using the CLI

Norn commands produce JSON unless they are help commands.

```bash
norn help
norn help runs start
norn commands list
norn commands inspect runs.start
```

Discover the current project and available workflows:

```bash
norn project inspect
norn workflows list
norn workflows list --all
norn workflows inspect example.plan
```

Start a workflow by passing params through stdin:

```bash
printf '{"params":{"task":"Add tests"}}' | norn runs start example.plan
```

The start command returns a run id and generated name. Use either value in later
commands:

```bash
norn runs list
norn runs inspect quiet-river-lantern
norn runs wait quiet-river-lantern
norn runs logs quiet-river-lantern
norn runs logs quiet-river-lantern --follow
norn runs metrics quiet-river-lantern
```

Resume an interrupted run by passing the updated params through stdin:

```bash
printf '{"params":{"decision":"accept","notes":"Looks good"}}' | norn runs resume quiet-river-lantern
```

To retry a failed or stopped run, restore an earlier checkpoint and resume:

```bash
norn runs checkpoints quiet-river-lantern
norn runs rollback quiet-river-lantern checkpoint-1
norn runs resume quiet-river-lantern
```

Stop or delete inactive runs explicitly:

```bash
norn runs stop quiet-river-lantern
norn runs kill quiet-river-lantern
norn runs delete quiet-river-lantern
```

Check the installed version and supported upgrade path:

```bash
norn version
norn upgrade --dry-run
```

## Development

```bash
npm run check
npm test
npm run pack:dry
```

Checks cover TypeScript, skill structure and size, and regression tests.

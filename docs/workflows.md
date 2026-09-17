# Workflow authoring with the Norn SDK

The Norn SDK is the TypeScript interface for building reusable workflows. A workflow can execute code and commands, delegate work to [Norn agents](agents.md), or combine both. Norn is the runtime that runs those workflows; the [CLI and client](cli.md) expose its lifecycle. The npm package currently supplies both runtime and SDK, with authoring imports from `norn`, `norn/api`, and related exports. No separate SDK package is required.

Start with the complete [minimal plugin](../examples/minimal-workflow/plugin.ts) and its [write/run/change exercise](../examples/minimal-workflow/README.md). Split files only as the implementation requires; a manifest, state module, and directory per step are not prerequisites.

## Declaration and implementation

`definePluginManifest` qualifies workflow keys as `pluginId.workflowKey`, binds Zod params, optional plugin config, and optional state declarations. `definePlugin` binds every declared key to an implementation. Entrypoints need nonempty caller-facing `instructions`; internal steps may omit them. `isEntrypoint` controls default catalogue visibility, not an authorization boundary: the CLI can start a known internal workflow ID directly.

`instructions` describe selection, inputs, effects, and outputs. They are neither a Norn agent system prompt nor a gate decision. Params and plugin config are parsed before execution. Public contracts must support JSON Schema inspection; JSON params must survive persistence and later parsing.

The implementation's `execute(run, params, config)` returns one control result:

| Control | Meaning |
|---|---|
| `run.next(target, params)` | Transfer to another registered workflow in the same run. See [composition](composition.md). |
| `run.complete(metadata)` | Complete the whole run, optionally exposing `summary`, `artifacts`, `logs`, and `data`. |
| `run.fail({ summary, ...metadata })` | Record failure with an actionable explanation and optional evidence. |

Throwing also fails execution. Neither a Norn agent returning text nor writing an artifact completes the run. Outcome `data` has no workflow-specific result schema enforced by Norn: the capability must define and validate its own result contract.

| Decision | GOOD | BAD |
|---|---|---|
| IF a required outcome was prevented, THEN return failure or reach an explicitly declared gate. ELSE complete with evidence for the actual outcome. | Delivery failure retains assessment refs and reports the delivery error. | A completed wrapper whose separate coordinator still has required work pending. |
| IF a helper only transforms data, THEN keep it an ordinary function. ELSE use a workflow boundary when control and recovery must be retained. | Local label normalization inside a persisted assessment step. | A workflow transition for each string operation. |

## Commands

`run.commands.run` accepts a shell string or an executable/argument tuple, records stdout/stderr logs, and returns exit status and bounded output tails:

```ts
const verification = await run.commands.run({
  label: "verify",
  cwd: run.cwd,
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

This fragment requires a working tree with dependencies at `run.cwd`; Norn's default workspace is initially empty. [Workspace setup](persistence.md#filesystem-boundaries) is explicit.

| Decision | GOOD | BAD |
|---|---|---|
| IF command success is required, THEN check `exitCode` and retain relevant log refs. ELSE interpret nonzero status according to that command's contract. | `npm test` exit 1 causes `run.fail`. | Assume a nonzero command automatically fails the workflow. |
| IF command arguments include untrusted values, THEN pass an executable/argument tuple or validate the shell input. ELSE use a shell string for intentional shell syntax. | `["git", "show", validatedRevision]`. | Interpolate arbitrary source text into a shell command. |

The scheduler executes one workflow at a time (at most 1,000 steps). Ordinary TypeScript concurrency is available inside a step; shared-file writes and effect ordering still need explicit coordination. For agent orchestration, [Norn agent sessions](agents.md) expose agent lifecycle within the run rather than an independently managed coordinator.

Sources: [Norn SDK public types and API](../src/api.ts), [execution registry](../src/internal/workflow-registry.ts), [commands](../src/internal/commands.ts), [scheduler](../src/internal/engine.ts).

# Composition and reuse

## Transfer, not a returning call

```ts
return run.next(manifest.workflows.analyze, { draftArtifact });
```

`run.next` constructs a control result. Returning it lets the scheduler persist the transition and execute the target in the **same run**, with that target's isolation mode. It does not suspend the caller and later return a value. Awaiting `run.next` cannot turn it into a subroutine.

The caller and target share run state and artifacts, not local variables or agent conversations. All targets must be registered in the loaded project. Params are validated at the target; a returned `complete` completes the entire run.

## Caller-selected continuation

A reusable capability can accept a continuation whose schema describes the values it contributes. The caller owns the remaining params:

```ts
import { artifactRefSchema, workflowRefSchema } from "@vimhead.dev/norn";
import { Type } from "typebox";

const paramsSchema = Type.Object({
  task: Type.String(),
  next: Type.Union([
    workflowRefSchema({
      params: Type.Object({
        resultArtifact: artifactRefSchema,
        summary: Type.String(),
      }),
    }),
    Type.Null(),
  ]),
});
```

After producing `resultArtifact` and `summary`, the reusable implementation returns:

```ts
return params.next
  ? run.next(params.next.workflow, {
      ...params.next.forwardParams,
      resultArtifact,
      summary,
    })
  : run.complete({ summary, artifacts: { result: resultArtifact } });
```

A caller supplies a registered target and its own context:

```json
{
  "params": {
    "task": "Assess this import",
    "next": {
      "workflow": "importer.deliver",
      "forwardParams": { "batchId": "batch-17" }
    }
  }
}
```

`importer.deliver` must accept `batchId`, `resultArtifact`, and `summary`. Code supplies a declaration's `.id` as the reference's workflow string. A bare ID string decodes to a reference with empty `forwardParams`; an object reference supplies both `workflow` and `forwardParams`.

`workflows inspect` exposes `x-norn-workflow-ref.contributedParamsSchema` at the reference's JSON Schema node. This is the producer's contribution contract, not extra fields required in the caller's reference payload. It does not automatically merge params, verify the target exists, or prove the target accepts the combination.

| Decision | GOOD | BAD |
|---|---|---|
| IF a caller selects the next step, THEN forward its opaque params and add the declared contribution explicitly. ELSE transition to a known declaration with explicit params. | Spread `forwardParams`, then add the producer-owned result fields. | Hardcode a task-specific next workflow into a supposedly reusable producer. |
| IF resuming the caller requires additional work, THEN represent that work as the supplied continuation. ELSE let the producer complete. | `assess → caller.deliver`. | Expect execution to return to the line following `run.next`. |
| IF a target schema changes, THEN inspect and exercise the combined params contract. ELSE preserve its existing input contract. | Verify the target accepts both batch context and result ref. | Treat the contributed schema annotation as automatic end-to-end compatibility checking. |

The [worktree development loop](../examples/worktree-development-loop/README.md) is a larger continuation-based example, not a required planner/reviewer architecture.

## Another project or harness

Reuse source by explicitly registering it, directly or through [included config](projects.md). There is no required package layout. Plugin IDs must remain unique within a project; run state and artifacts belong to the invoking project/run, not the plugin source directory.

An external shell, Python program, or agent harness can call the [CLI](cli.md) from the target project directory. The JavaScript client offers the same lifecycle without inventing another orchestration layer. Separate CLI starts create separate runs; connecting their artifact content is a caller responsibility, unlike same-run continuation refs.

Sources: [reference schemas and controls](../packages/sdk/src/api.ts), [scheduler](../packages/cli/src/internal/engine.ts), [reference contract tests](../tests/workflow-ref.test.ts).

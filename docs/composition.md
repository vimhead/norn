# Composition and reuse

## Transfer, not a returning call

```ts
return manifest.workflows.analyze({ draftArtifact });
```

Qualified workflow declarations are callable and retain `.id`, `.params`, instructions, gates and isolation metadata. Calling one constructs a control result from its complete **encoded** input. Returning that result lets the scheduler persist the transition and execute the target in the **same run**, with that target's isolation mode. Calling or awaiting a declaration does not execute its implementation inline or return its eventual result.

The caller and target share run state and artifacts, not local variables or agent conversations. All targets must be registered in the loaded project. The target decodes the assembled params before execution; a returned `complete` completes the entire run.

For a dynamically selected string ID, use `run.next(workflowId, params)`. It constructs the same result, but parameter checking belongs to the selected target at runtime. `run.next` accepts IDs, not declarations or decoded reference functions.

## Caller-selected workflow reference

A reusable capability can accept a workflow reference whose schema describes the values it contributes. The caller supplies the target and captures the remaining params:

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

A caller supplies encoded JSON:

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

Code uses a declaration's `.id` in the reference payload, not the declaration itself. A bare ID string is shorthand for an object reference with empty `forwardParams`.

Native TypeBox decoding turns `next` into a function capturing that target and caller input. After producing its result, the implementation returns:

```ts
return params.next
  ? params.next({ resultArtifact, summary })
  : run.complete({ summary, artifacts: { result: resultArtifact } });
```

The reference checks the contribution with `Value.Assert`, shallow-merges captured params followed by contributed fields, and constructs the same control result as a declaration call. Contributed fields win collisions; captured input is not mutated. Contribution schemas can describe object-valued records, unions, intersections and codecs as well as `Type.Object`. Arguments use the schema's encoded direction; contribution decode callbacks do not run during invocation. Scalars and arrays cannot be contributions to this flat object merge.

`importer.deliver` must accept the assembled `batchId`, `resultArtifact` and `summary`. A valid contribution does not prove that the target exists or accepts the caller's captured input. The scheduler resolves the target and applies its actual input contract.

`workflows inspect` exposes `x-norn-workflow-ref.contributedParamsSchema` at the reference's JSON Schema node. This is the producer's contribution contract, not extra fields required in the caller's reference payload. Inspection validates embedded contribution schemas, including nested reference annotations.

The decoded function is an execution-local value. Queued runs, gates and checkpoints retain the encoded reference; recovery decodes it again. Workflow input persisted by Norn must remain JSON data, not decoded reference functions.

## Multiple outcomes and direct targets

References can be nested under ordinary author-selected names with independent contribution schemas:

```ts
const next = Type.Object({
  success: workflowRefSchema({
    params: Type.Object({ resultArtifact: artifactRefSchema }),
  }),
  failure: workflowRefSchema({
    params: Type.Object({ reason: Type.String() }),
  }),
});
```

An implementation can return `params.next.success({ resultArtifact })`, `params.next.failure({ reason })`, or select its own known target with `manualReviewWorkflow({ task, reason })`. A dynamic target still uses `run.next(selectedId, input)`.

These are alternative transitions, not fan-out. `success` and `failure` are not reserved names, and a failure reference does not catch unhandled exceptions automatically.

| Decision | GOOD | BAD |
|---|---|---|
| IF the caller selects the next step, THEN invoke its decoded reference with the declared contribution. ELSE call a known declaration or use a dynamic ID. | `params.next({ resultArtifact })` | Manually reconstruct captured forwarding input. |
| IF additional caller work follows the result, THEN represent it as the supplied reference. ELSE complete the run. | `assess → caller.deliver` | Expect execution to return to the line following a workflow call. |
| IF a target schema changes, THEN exercise the assembled input contract. ELSE preserve its existing input contract. | Verify the target accepts captured context and contributed results. | Treat contribution metadata as end-to-end compatibility proof. |

The [worktree development loop](../examples/worktree-development-loop/README.md) is a larger multi-step example using known workflow declarations, not a required planner/reviewer architecture.

## Another project or harness

Reuse source by explicitly registering it, directly or through [included config](projects.md). There is no required package layout. Plugin IDs must remain unique within a project; run state and artifacts belong to the invoking project/run, not the plugin source directory.

An external shell, Python program, or agent harness can call the [CLI](cli.md) from the target project directory. The JavaScript client offers the same lifecycle without inventing another orchestration layer. Separate CLI starts create separate runs; connecting their artifact content is a caller responsibility, unlike same-run references.

Sources: [reference schemas and controls](../packages/sdk/src/api.ts), [scheduler](../packages/cli/src/internal/engine.ts), [reference contract tests](../tests/workflow-ref.test.ts).

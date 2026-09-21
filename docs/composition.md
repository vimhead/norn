# Composition and reuse

## Transfer, not a returning call

```ts
return analyze({ draftPath });
```

Return a workflow call to select the next step in the same run. Supply its complete input; TypeScript checks it against the declaration's args schema. The target must be registered in the loaded project.

This transfers control rather than calling a subroutine: awaiting the declaration does not execute the target or return its eventual result. Steps share workspace files, not local variables or agent conversations. `run.complete` completes the whole run.

For a dynamically selected string ID, use `return run.next(workflowId, args)`. The selected target checks its input at runtime. `run.next` accepts IDs, not declarations or reference functions.

## Caller-selected workflow reference

The [caller-selected continuation example](../examples/caller-selected-continuation/README.md)
runs a producer with either of two caller-selected consumers, forwarding caller
context alongside the producer's results. It needs no model or credentials.

A reusable capability can accept a workflow reference whose schema describes the values it contributes. The caller supplies the target and captures the remaining args:

```ts
import { workflowRefSchema } from "@vimhead.dev/norn";
import { Type } from "typebox";

const argsSchema = Type.Object({
  task: Type.String(),
  next: Type.Union([
    workflowRefSchema({
      args: Type.Object({
        resultPath: Type.String(),
        summary: Type.String(),
      }),
    }),
    Type.Null(),
  ]),
});
```

A caller supplies the target and its own parameters:

```json
{
  "args": {
    "task": "Assess this import",
    "next": {
      "workflow": "importer.deliver",
      "forwardArgs": { "batchId": "batch-17" }
    }
  }
}
```

Code uses a declaration's `.id` in the reference payload, not the declaration itself. A bare ID string is shorthand for an object reference with empty `forwardArgs`.

Inside the workflow, `args.next` is a function. Supply only the result fields declared above:

```ts
return args.next
  ? args.next({ resultPath, summary })
  : run.complete({ summary, data: { resultPath } });
```

`importer.deliver` receives `batchId` from the caller plus `resultPath` and `summary` from the producer. Its args schema must accept all three. Produced fields replace caller fields with the same name; nested objects are replaced, not deep-merged.

Contributions must be JSON objects matching the declared input type. Object-valued records, unions, intersections and codecs are supported. With codecs, supply `StaticEncode` values, just as for a direct workflow call—not transformed `StaticDecode` values.

`workflows inspect` shows the contribution contract under `x-norn-workflow-ref.contributedArgsSchema`. Use it alongside the target's args schema to check that the combined input fits.

When passing a reference as input to another workflow, supply its JSON form shown above, not the function received in `args.next`.

## Caller-owned routing policy

A continuation can be a caller-owned router rather than the final consumer. The
[caller-owned routing example](../examples/caller-owned-routing/README.md) combines
assessment and revision workflows: assessment reports findings, revision produces
an updated outline, and the router owns the acceptance threshold, next action,
and iteration limit. Neither reusable capability knows the caller's policy.

Task-level findings and run-level completion are separate: a caller may accept
some findings, request more work, or fail when its revision budget is exhausted.

| Decision | GOOD | BAD |
|---|---|---|
| IF callers need different acceptance or follow-up policies, THEN supply a caller-owned router as the continuation. ELSE use a direct continuation. | Route the same assessment to completion or revision using caller thresholds. | Embed one caller's revision budget in a reusable assessment, or add a router to unconditional delivery. |

## Multiple outcomes and direct targets

References can be nested under ordinary author-selected names with independent contribution schemas:

```ts
const next = Type.Object({
  success: workflowRefSchema({
    args: Type.Object({ resultPath: Type.String() }),
  }),
  failure: workflowRefSchema({
    args: Type.Object({ reason: Type.String() }),
  }),
});
```

An implementation can return `args.next.success({ resultPath })`, `args.next.failure({ reason })`, or select its own known target with `manualReviewWorkflow({ task, reason })`. A dynamic target still uses `run.next(selectedId, input)`.

These are alternative transitions, not fan-out. `success` and `failure` are not reserved names, and a failure reference does not catch unhandled exceptions automatically.

| Decision | GOOD | BAD |
|---|---|---|
| IF the caller selects the next step, THEN invoke its reference with the declared contribution. ELSE call a known declaration or use a dynamic ID. | `args.next({ resultPath })` | Manually reconstruct captured forwarding input. |
| IF additional caller work follows the result, THEN represent it as the supplied reference. ELSE complete the run. | `assess → caller.deliver` | Expect execution to return to the line following a workflow call. |
| IF a target schema changes, THEN exercise the assembled input contract. ELSE preserve its existing input contract. | Verify the target accepts captured context and contributed results. | Treat contribution metadata as end-to-end compatibility proof. |

The [worktree development loop](../examples/worktree-development-loop/README.md) is a larger multi-step example using known workflow declarations, not a required planner/reviewer architecture.

## Another project or harness

Reuse source by explicitly registering it, directly or through [included config](projects.md). There is no required package layout. Workflow IDs must remain unique within a project; shared scopes follow the [scope declaration contract](workflows.md#shared-scopes-and-configuration). Resources and workspace files belong to the invoking run, not the workflow source directory.

An external shell, Python program, or agent harness can call the [CLI](cli.md) from the target project directory. The JavaScript client offers the same lifecycle without inventing another orchestration layer. Separate CLI starts create separate runs; connecting their files is a caller responsibility. Relative paths must use the base declared by the producing workflow; see [file persistence](persistence.md).

Sources: [reference schemas and controls](../packages/sdk/src/api.ts), [scheduler](../packages/cli/src/internal/engine.ts), [reference contract tests](../tests/workflow-ref.test.ts).

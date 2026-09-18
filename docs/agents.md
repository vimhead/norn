# Norn agents

A Norn agent is a workflow-managed session powered by the bundled, open-source and extensible [Pi coding agent](https://pi.dev). Pi supplies the agent implementation regardless of which [outer harness invokes Norn](cli.md#javascript-client-and-other-harnesses). Extensions, skills, and custom providers can customize these sessions; their loading and boundaries are described below.

The [Norn agent → saved artifact → analysis example](../examples/agent-then-analysis/README.md) is a complete two-session application. Agent outputs flow through a saved contract, not shared conversation history.

## One prompt or a retained session

`run.agents.prompt({ label, prompt, response, ...sessionOptions })` creates a Pi session for one prompt and returns the value described by the response schema, including any codec transformations—not `{ response, raw }`. You do not need to dispose this one-prompt session. See [schema input/output types](schemas.md#codecs-and-inputoutput-types).

For follow-up turns in the same conversation:

```ts
const agentSession = await run.agents.createSession({
  label: "implementation",
  cwd: run.cwd,
  tools: ["read", "bash", "edit", "write"],
});
try {
  const implementation = await agentSession.prompt({
    prompt: task,
    response: implementationSchema,
    maxAttempts: 2,
  });
  const verification = await agentSession.prompt({
    prompt: JSON.stringify({ task: "Verify the saved changes", implementation }),
    response: verificationSchema,
    maxAttempts: 2,
  });
  const verificationArtifact = await run.artifacts.write("verification.json", JSON.stringify(verification));
  return run.complete({ artifacts: { verification: verificationArtifact } });
} finally {
  await agentSession.dispose();
}
```

`task` and both TypeBox schemas are capability-specific inputs in this fragment. [Provider setup](providers.md) is a prerequisite for Norn agents; detached execution cannot conduct an interactive login.

## Response contract and evidence

Norn adds `pi_workflows_agent_response` to the requested tools and supplies the schema and response instructions. If a turn omits that tool call, Norn requests finalization with only that tool active. Invalid or missing structured responses can be retried in the same session (`maxAttempts`, default 3). This is response-contract recovery, not a domain retry policy or a retry of every provider exception.

Successful results and raw attempts are written under `current/logs/agents/`; Pi session files live under `current/sessions/`. A schema-valid response establishes shape, not factual support, successful external effects, or task completion.

| Decision | GOOD | BAD |
|---|---|---|
| IF later work needs independent judgment, THEN create a fresh session and pass only its input/evidence contract. ELSE retain a session for conversation-dependent follow-up. | Analysis receives saved source and draft, not the author's conversation. | Call an author again and describe its self-review as independent. |
| IF a Norn agent claims a verifiable result, THEN verify the evidence before accepting it. ELSE preserve the uncertainty in the result. | Check quotations against source bytes and command outcomes against logs. | Treat a schema-valid `passed: true` as proof that tests ran. |
| IF a result must survive a workflow transition, THEN save its content/ref using [persistence](persistence.md). ELSE keep it local to the active step. | Save a draft artifact, then pass its ref to analysis. | Expect the next workflow to recover a local variable or an undisposed session object. |

## Prompts, tools, and resource loading

The default tool allowlist is `read`, `bash`, `edit`, `write`, plus the response tool. An explicit `tools: []` requests no built-in task tools, but still includes the response tool and any explicitly attached [resource-adapter tools](resources.md#explicit-agent-attachment). `resourceAdapters` is accepted by both session creation and one-shot prompting; omitting it attaches no workflow state.

Each session loads resources for its `cwd` and [Norn configuration](providers.md#norn-configuration). Installed provider extensions register before default-model selection. Both `run.agents.createSession` and `run.agents.prompt` accept per-session `model` and `thinkingLevel` overrides; omitted values use Pi's configured selection and defaults. Discoverable settings, skills, context files, and extensions can therefore affect it. It does **not** inherit the outer conversation or its in-memory tool registrations. Loaded extensions may change active tools; the requested tool list alone is not an adversarial restriction.

`systemPrompt` replaces the base prompt; `appendSystemPrompt` adds to resource-loader append content. Pi's default self-documentation block is absent with a custom base prompt. Context files and applicable skill advertisements can still be appended by Pi. Norn currently does not automatically inject a Norn authoring bootstrap.

| Decision | GOOD | BAD |
|---|---|---|
| IF a custom-prompt Norn agent must author capabilities, THEN deliberately supply the matching documentation locations and authoring scope. ELSE keep authoring material out of a source-only assessor's supplied prompt. | Author gets installed Norn references; assessor gets source and result. | Inject the entire parent task and authoring manual into every agent. |
| IF strict evidence/tool isolation is required, THEN control the Pi resource environment and inspect the effective session, using an OS boundary for filesystem restrictions. ELSE describe this as conversation separation only. | Verify loaded context and active tools in a controlled agent environment. | Call `tools: []` plus a fresh session a filesystem sandbox. |

Sources: [session API](../packages/sdk/src/api.ts), [agent runner](../packages/cli/src/internal/agents.ts), [response tool](../packages/cli/src/internal/agent-response-tool.ts). Filesystem semantics: [workspaces](persistence.md#filesystem-boundaries).

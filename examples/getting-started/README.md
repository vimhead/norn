# Combine an agent with code

The agent summarizes supplied text; code saves the summary as `summary.txt`.
The complete workflow is in [plugin.ts](plugin.ts), registered by
[norn.project.json](norn.project.json).

## Setup and run

[Install Norn](../../README.md#installation), including agent authentication and a
default model. This example makes a live model call. No local SDK installation or
compilation step is required.

Copy this directory to a writable task directory and `cd` into the copy, keeping
[the runtime matched to the example](../../docs/cli.md#select-the-runtime).
Then follow [Getting started, step 3](../../README.md#getting-started) to run it.

## Inspect the result

`runs wait` returns the run details. Check that `run.status` is `completed`;
a successful CLI exit alone does not mean the workflow succeeded. The outcome's
`metadata.artifacts.summary` refers to `summary.txt` under
`.norn/runs/<run-id>/current/artifacts/`. Read it to assess the summary itself.

Change the prompt or supply different text to reuse the workflow.
[Norn agents](../../docs/agents.md) covers structured responses, model selection,
and inherited resources; `tools: []` is not a security sandbox.

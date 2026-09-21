# Summarize a Git diff with a command and an agent

`commands.run` collects `git diff HEAD`, an agent summarizes it, and code saves
`summary.txt` in the run workspace. The complete workflow is in
[plugin.ts](plugin.ts), registered by [norn.project.json](norn.project.json).

## Setup and run

[Install Norn](../../README.md#installation), including agent authentication and a
default model. Git must be on `PATH`. No local SDK installation or compilation
step is required.

Copy this directory to a writable task directory and `cd` into the copy, keeping
[the runtime matched to the example](../../docs/cli.md#select-the-runtime).
The example directory need not be inside the repository being summarized.
Then follow [Getting started, step 3](../../README.md#getting-started), supplying
an absolute `repositoryPath` for a checkout with at least one commit.

`git diff HEAD` includes staged and unstaged tracked changes, not untracked
files. Use a small diff and review it before running: the full patch is retained
in the run's command log and sent to the configured model. The command reads the
repository without modifying its files or index; the summary is saved separately
in the run workspace.

## Inspect the result

`runs wait` returns the run details. Check that `run.status` is `completed`;
a successful CLI exit alone does not mean the workflow succeeded. The outcome's
`metadata.data.summaryPath` is `"summary.txt"`, relative to the absolute
`run.paths.workspace` reported in those run details. Read that file and compare
it with the diff to assess the summary. `metadata.logs.diff` references the
recorded patch.

An empty diff writes `No tracked changes relative to HEAD.` without calling a
model. A failed Git command fails the workflow before prompting and exposes
stdout/stderr log references; a repository without a commit cannot resolve `HEAD`.
The Git command has a 10-second timeout, not a budget for the entire workflow.

Change the prompt or supply another repository to reuse the workflow.
[Norn agents](../../docs/agents.md) covers structured responses, model selection,
and inherited resources; `tools: []` is not a security sandbox.

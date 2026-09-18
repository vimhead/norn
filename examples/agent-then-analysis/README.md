# Norn agent → saved artifact → analysis

```text
sourceSummary.draft
  Norn drafting agent → draft.json + saved ref
  return next (checkpoint)
sourceSummary.analyze
  read saved draft → verify quotations → fresh Norn analysis agent → analysis.json
```

The drafting agent summarizes supplied source text. The analysis workflow reads
only the saved source/draft contract and uses a different conversation to assess
support and omissions. It does not receive the author's conversation. This is a
small application, not a prescribed development pipeline.

## Setup and run

[Select the matching runtime](../../docs/cli.md#select-the-runtime), copy this
directory to a writable task directory, and `cd` into the copy. Configure
[Norn agent authentication and a default model](../../docs/providers.md)
beforehand; this example makes live model calls and the detached executor cannot
prompt for login.

Both Norn agents request `tools: []` and use custom role prompts; Norn retains its
structured-response tool. Normal Pi resource discovery still applies. This is
not a security-isolated/source-only harness; [agent resource boundaries](../../docs/agents.md#prompts-tools-and-resource-loading)
explain how inherited context and extensions can affect effective prompts/tools.

```bash
norn project inspect
norn workflows list --all
norn workflows inspect sourceSummary.draft
norn runs start sourceSummary.draft < input.json
```

Copy the returned ID:

```bash
RUN=<returned-run-id>
norn runs wait "$RUN"
norn runs inspect "$RUN"
norn runs checkpoints "$RUN"
norn runs metrics "$RUN"
```

Expected successful structure (wording and verdict are model-dependent):

- `status: completed`, with draft and analysis refs in outcome metadata.
- `current/artifacts/draft.json`: `{ source, draft: { summary, quotations, uncertainties } }`.
- `current/artifacts/analysis.json`: `{ verdict, reason, issues }`.
- A `sourceSummary.draft -> sourceSummary.analyze` transition checkpoint.
- Norn agent records labeled `draft` and `analysis`, with separate Pi sessions.

Paths are under `.norn/runs/$RUN/`. Read the actual artifacts and compare them
against [input.json](input.json); a run ID or valid schema is not evidence of a
correct assessment. `needs-revision` means analysis completed and found problems,
not that the summary is approved. Missing verbatim quotations fail the run before
the analyst; provider/response failures also prevent successful completion.

## Repair only the analysis step

This exercise changes only a **copied example**, not runtime source. It injects an
analysis failure to make the recovery boundary visible without requiring an
external service outage.

1. In `plugin.ts`, at the beginning of `analyze.execute`, temporarily add
   `throw new Error("Analysis repair exercise");`.
2. Start a new run with `input.json` and wait. It should fail in
   `sourceSummary.analyze` after the drafting agent has saved its result.
3. Read `current/artifacts/draft.json` and retain its bytes for comparison.
   List checkpoints and select the actual ID whose message is
   `transition: sourceSummary.draft -> sourceSummary.analyze`.
4. Remove the injected throw. Inspect `sourceSummary.analyze` with a new CLI
   invocation, then recover the **same run**:

   ```bash
   norn workflows inspect sourceSummary.analyze
   norn runs rollback "$RUN" <transition-checkpoint-id>
   norn runs resume "$RUN" </dev/null
   norn runs wait "$RUN"
   norn runs inspect "$RUN"
   ```

5. Verify completion and byte-identical `draft.json`. Logs/metrics should show
   no second drafting agent: recovery executes analysis from the saved transition,
   rather than rerunning independently managed orchestration.

The live draft can itself contain invalid quotations; that is not an
analysis-only defect. [Recovery guidance](../../docs/recovery.md) distinguishes
repairing a consumer from regenerating invalid producer evidence.

## Change and reuse

Change the analysis criteria in the copied workflow and start a new run, or repair
an inactive failed analysis from its saved boundary. New source does not replace
code already loaded by a running executor. For a second source, supply another
`{"args":{"source":"..."}}` through the unchanged draft entrypoint.

The result schemas, saved source, artifact reference, and analysis args are the
reusable boundary. Analysis deliberately receives no domain task state through
module memory. [Persistence and artifacts](../../docs/persistence.md) describes the
storage contract; [composition](../../docs/composition.md) extends fixed
transitions to caller-selected continuations.

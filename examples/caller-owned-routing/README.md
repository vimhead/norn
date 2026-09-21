# Caller-owned routing

Combine reusable assessment and revision workflows without making either own the
caller's acceptance threshold or iteration limit. This code-only example checks
Markdown outline headings, not prose quality. No model, credentials, local
dependencies, or compilation step is required.

Start with [caller-selected continuation](../caller-selected-continuation/README.md)
for reference inputs and forwarded arguments. Here, the supplied continuation is
a router rather than a delivery step:

```text
assessOutline → routeAssessment → complete
                    │          → fail (revision limit)
                    ↓
               appendHeading → assessOutline → routeAssessment → …
```

## Capability versus caller policy

- [assessment.ts](assessment.ts) reports which required headings are missing. It
  does not decide whether those findings are acceptable or whether to revise.
- [revision.ts](revision.ts) appends one requested heading and contributes the
  revised outline. It knows neither the assessment workflow nor the router.
- [router.ts](router.ts) owns acceptance, heading selection, the revision budget,
  and the revision → reassessment → router chain. It saves the latest assessed
  outline as workspace-relative `outline.md`, including on budget exhaustion.
- [contracts.ts](contracts.ts) declares the contribution schemas shared by callers
  and capabilities; [norn.project.json](norn.project.json) registers all three workflows.
- [input.json](input.json) selects the router and captures its policy parameters
  through `next.forwardArgs`, starting with `revisionsUsed: 0`.

The router accepts an assessment with at most `maxMissingHeadings` findings.
Otherwise it requests one revision, unless `maxRevisions` has been reached, in
which case the run fails. Acceptance is checked first: the final allowed revision
can still succeed. `maxRevisions` is bounded to 100 for this example.

Only the router imports both capabilities. Their `next` references could instead
select other registered consumers without changing either capability. The nested
references in the router are ordinary JSON inputs: revision contributes `outline`
to assessment; assessment contributes its findings back to the router. The
[composition reference](../../docs/composition.md) owns reference semantics.

## Inspect and run

[Select the matching runtime](../../docs/cli.md#select-the-runtime), copy this
entire directory into a writable task directory, and `cd` into the copy.

```bash
norn project inspect
norn workflows list --all
norn workflows inspect assessOutline
norn workflows inspect appendHeading
norn workflows inspect routeAssessment
norn runs start assessOutline < input.json
```

Discovery should report `isComplete: true`. Copy the returned `run.id`:

```bash
RUN=<returned-run-id>
norn runs wait "$RUN"
norn runs inspect "$RUN"
norn runs checkpoints "$RUN"
```

Expected results:

- `run.status: completed`, `run.health: healthy`, and
  `run.outcome.workflowId: routeAssessment`.
- Outcome metadata `data` contains `outlinePath: "outline.md"`,
  `missingHeadings: []`, and `revisionsUsed: 2`.
- Transition checkpoints show assessment → router, then two repetitions of
  router → revision → assessment → router.

Read `outline.md` in the inspected `run.paths.workspace`:

```markdown
# Release notes

## Summary

## Changes

## Verification
```

These are empty sections, not a completed release note. The example's contract is
heading presence only; an actual content assessment needs a different capability.

## Change only the caller's policy

For each case, edit `args.next.forwardArgs` in `input.json`, start a **new** run,
and inspect that run and its `outline.md`. Leave both capability modules unchanged.

| `maxMissingHeadings` | `maxRevisions` | Expected result |
|---|---|---|
| `2` | `0` | Completes immediately with two missing headings and `revisionsUsed: 0`; no revision transition. |
| `1` | `2` | Completes after one revision, with only `Verification` missing. |
| `0` | `1` | Fails in the router after one revision, with `Verification` still missing; retained outline includes `Changes`. |
| `0` | `0` | Fails immediately with both headings missing; no revision transition. |

Keep `revisionsUsed: 0` for each fresh run. In the failure cases, the router reports
that the revision limit was reached rather than completing below the requested
threshold. A successful `runs wait` command alone does not imply workflow success.

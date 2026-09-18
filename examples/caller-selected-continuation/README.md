# Caller-selected continuation

This code-only example produces a greeting, then passes its artifact and summary
to a workflow selected by the caller. Both steps execute in one run. No model,
credentials, local dependencies, or compilation step is required; delivery here
means writing a local artifact, not contacting an external service.

## Declare and supply

- [producer.ts](producer.ts) declares `next` with `workflowRefSchema` and invokes
  `args.next({ resultArtifact, summary })`. It names no consumer workflow.
- [caller.ts](caller.ts) provides two consumers: `greetingConsumer.saveJson` and
  `greetingConsumer.saveText`. Each accepts the contributed fields plus `batchId`.
- [norn.project.json](norn.project.json) registers both workflow modules.
- [input.json](input.json) selects `greetingConsumer.saveJson` and supplies
  `batchId: "batch-17"` through `next.forwardArgs`.

The consumer reads the greeting artifact and completes the run with a delivery
artifact. The [composition reference](../../docs/composition.md#caller-selected-workflow-reference)
owns reference syntax, contribution schemas, and forwarding semantics.

## Inspect and run

[Select the matching runtime](../../docs/cli.md#select-the-runtime), copy this
entire directory into a writable task directory, and `cd` into the copy.

```bash
norn project inspect
norn workflows list --all
norn workflows inspect greetingProducer.write
norn workflows inspect greetingConsumer.saveJson
norn runs start greetingProducer.write < input.json
```

Discovery should report `isComplete: true`. Producer inspection exposes the
`resultArtifact`/`summary` contribution contract; consumer inspection also requires
`batchId`. Copy the returned `run.id`:

```bash
RUN=<returned-run-id>
norn runs wait "$RUN"
norn runs inspect "$RUN"
norn runs checkpoints "$RUN"
```

Expected results:

- `run.status: completed` and `run.health: healthy`.
- `run.outcome.workflowId: greetingConsumer.saveJson`.
- `run.outcome.metadata.data: { "batchId": "batch-17", "format": "json" }`.
- Artifact refs for `greeting.txt` and `delivery.json` in outcome metadata.
- A `greetingProducer.write -> greetingConsumer.saveJson` transition checkpoint.

Read `.norn/runs/$RUN/current/artifacts/delivery.json`; its content should be:

```json
{
  "batchId": "batch-17",
  "summary": "Greeting prepared for Ada.",
  "greeting": "Hello, Ada!"
}
```

## Select another consumer without changing the producer

In the copied `input.json`, change only `args.next.workflow` to
`greetingConsumer.saveText`. Inspect that consumer, start the producer again, and
wait on the **new** run ID. Its outcome should identify `greetingConsumer.saveText`,
report `format: "text"`, and reference `delivery.txt` containing
`batch-17: Hello, Ada!` followed by a newline. The first run retains its JSON delivery.

For a failure exercise, keep a valid consumer ID but change `forwardArgs` to
`{}`. Start and inspect a new run: it should fail because the consumer requires
`batchId`, with no delivery artifact. A valid producer contribution alone does
not establish compatibility with the consumer's complete input contract.

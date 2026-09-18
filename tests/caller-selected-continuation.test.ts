import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NornWorkflowArgsInput } from "@vimhead.dev/norn";
import { expect, test, type TestContext } from "vitest";
import type { write } from "../examples/caller-selected-continuation/producer.ts";
import { createNornClient } from "../packages/cli/src/client.ts";

async function copyContinuationExample(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "norn-continuation-"));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	await cp(new URL("../examples/caller-selected-continuation/", import.meta.url), root, { recursive: true });
	const input: { args: NornWorkflowArgsInput<typeof write> } = JSON.parse(await readFile(join(root, "input.json"), "utf8"));
	return { client: createNornClient({ spawnCwd: root }), args: input.args };
}

test("the copied continuation example exposes its contribution contract and completes in the supplied consumer", async context => {
	const { client, args } = await copyContinuationExample(context);
	const catalogue = await client.workflows.list({ all: true });
	assert.equal(catalogue.isComplete, true);
	assert.deepEqual(catalogue.workflows.map(workflow => workflow.id).sort(), [
		"greetingConsumer.saveJson", "greetingConsumer.saveText", "greetingProducer.write",
	]);
	const producer = await client.workflows.inspect("greetingProducer.write");
	expect(producer.workflow?.argsSchema).toHaveProperty("properties.next.x-norn-workflow-ref.contributedArgsSchema.required", ["resultArtifact", "summary"]);
	const consumer = await client.workflows.inspect("greetingConsumer.saveJson");
	expect(consumer.workflow?.argsSchema).toHaveProperty("required", ["batchId", "resultArtifact", "summary"]);
	const started = await client.runs.start({ workflowId: "greetingProducer.write", args });
	const finished = await client.runs.wait(started.id);
	assert.equal(finished.status, "completed", JSON.stringify(finished));
	assert.equal(finished.health, "healthy");
	assert.equal(finished.outcome?.workflowId, "greetingConsumer.saveJson");
	assert.deepEqual(finished.outcome?.metadata?.data, { batchId: "batch-17", format: "json" });
	assert.deepEqual(finished.outcome?.metadata?.artifacts, { greeting: { path: "greeting.txt" }, delivery: { path: "delivery.json" } });
	assert.equal(await readFile(join(finished.path, "current/artifacts/greeting.txt"), "utf8"), "Hello, Ada!");
	assert.deepEqual(JSON.parse(await readFile(join(finished.path, "current/artifacts/delivery.json"), "utf8")), {
		batchId: "batch-17", summary: "Greeting prepared for Ada.", greeting: "Hello, Ada!",
	});
	assert.ok((await client.runs.checkpoints(started.id)).some(checkpoint => checkpoint.message === "transition: greetingProducer.write -> greetingConsumer.saveJson"));
});

test("changing only the caller reference selects another consumer and forwards its batch ID", async context => {
	const { client, args } = await copyContinuationExample(context);
	const started = await client.runs.start({
		workflowId: "greetingProducer.write",
		args: { ...args, next: { workflow: "greetingConsumer.saveText", forwardArgs: { batchId: "batch-99" } } },
	});
	const finished = await client.runs.wait(started.id);
	assert.equal(finished.status, "completed", JSON.stringify(finished));
	assert.equal(finished.health, "healthy");
	assert.equal(finished.outcome?.workflowId, "greetingConsumer.saveText");
	assert.deepEqual(finished.outcome?.metadata?.data, { batchId: "batch-99", format: "text" });
	assert.deepEqual(finished.outcome?.metadata?.artifacts?.delivery, { path: "delivery.txt" });
	assert.equal(await readFile(join(finished.path, "current/artifacts/delivery.txt"), "utf8"), "batch-99: Hello, Ada!\n");
});

test("a producer contribution cannot complete delivery without the consumer's required caller context", async context => {
	const { client, args } = await copyContinuationExample(context);
	const started = await client.runs.start({
		workflowId: "greetingProducer.write",
		args: { ...args, next: { workflow: "greetingConsumer.saveJson", forwardArgs: {} } },
	});
	const finished = await client.runs.wait(started.id);
	assert.equal(finished.status, "failed", JSON.stringify(finished));
	assert.ok(finished.failed);
	assert.equal(await readFile(join(finished.path, "current/artifacts/greeting.txt"), "utf8"), "Hello, Ada!");
	await assert.rejects(readFile(join(finished.path, "current/artifacts/delivery.json")), { code: "ENOENT" });
});

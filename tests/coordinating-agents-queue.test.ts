import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "vitest";
import { NornRunResources, type NornAgentResourceBinding } from "../src/index.ts";
import { NornRunStore } from "../src/internal/run-store.ts";
import { QueueAdapter } from "../examples/coordinating-multiple-agents/queue-adapter.ts";
import { WorkQueue, workQueueDefinition } from "../examples/coordinating-multiple-agents/work-queue.ts";

async function createQueueFixture(context: TestContext, overrides: { now?: () => number; leaseDurationMs?: number } = {}) {
	const root = await mkdtemp(join(tmpdir(), "norn-example-queue-"));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const leaseDurationMs = overrides.leaseDurationMs ?? 300_000;
	const definition = { ...workQueueDefinition, configuration: { format: 1, leaseDurationMs }, async initialize(resource: Parameters<typeof workQueueDefinition.initialize>[0]) {
		const queue = new WorkQueue({ path: join(resource.directory, "queue.json"), files: resource.files, leaseDurationMs, now: overrides.now ?? Date.now, createToken: randomUUID });
		await queue.initialize(resource.mode);
		return queue;
	} };
	const resources = await NornRunResources.initialize(root);
	return { root, resources, definition, queue: await resources.ensure(definition), path: join(root, "current/resources/summaries/queue.json") };
}

async function invoke(binding: NornAgentResourceBinding, input: { tool: string; args: object; signal?: AbortSignal }) {
	const tool = binding.tools.find(tool => tool.name === input.tool);
	assert.ok(tool, `Expected attached tool: ${input.tool}`);
	return tool.execute("test", input.args, input.signal, undefined, {} as never);
}

function startWorker(context: TestContext, input: { root: string; mode: "consume" | "hold"; owner: string; leaseDurationMs: number }) {
	const child = spawn(process.execPath, ["--input-type=module", "--eval", 'import { createJiti } from "jiti"; await createJiti(import.meta.url, { moduleCache: false }).import(process.argv[1]);', fileURLToPath(new URL("./fixtures/coordinating-agents-queue-worker.ts", import.meta.url)), input.root, input.mode, input.owner, String(input.leaseDurationMs)], { stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.on("data", chunk => { stderr += chunk; });
	const completed = new Promise<void>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code, signal) => code === 0 || (input.mode === "hold" && signal === "SIGKILL") ? resolve() : reject(new Error(stderr || `Worker exited: ${code}`)));
	});
	context.onTestFinished(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await completed; });
	return { child, completed };
}

test("example queue identity and values survive reopen; retries cannot change a note or result", async context => {
	const { queue, resources, definition, root } = await createQueueFixture(context);
	assert.deepEqual(await queue.enqueue({ id: "first", text: "source", signal: undefined }), { isNew: true });
	assert.deepEqual(await queue.enqueue({ id: "first", text: "source", signal: undefined }), { isNew: false });
	await assert.rejects(queue.enqueue({ id: "first", text: "different", signal: undefined }), /Conflicting queue note/);
	const claim = await queue.claim({ owner: "worker", signal: undefined });
	assert.ok(claim);
	const acknowledgment = { ...claim, owner: "worker", result: { summary: "result", quote: "source" }, signal: undefined };
	await queue.acknowledge(acknowledgment);
	const reopened = await (await NornRunResources.initialize(root)).ensure(definition);
	await reopened.acknowledge(acknowledgment);
	await assert.rejects(reopened.acknowledge({ ...acknowledgment, result: { summary: "changed", quote: "source" } }), /Conflicting queue result/);
	assert.strictEqual(await resources.ensure(definition), queue);
	assert.equal((await reopened.inspect()).acknowledged, 1);
	assert.equal(await reopened.claim({ owner: "other", signal: undefined }), null);
	await assert.rejects((await NornRunResources.initialize(root)).ensure({ ...definition, configuration: { format: 2 } }), /Incompatible resource definition/);
});

test("competing acknowledgment retries retain one complete result", async context => {
	const { queue } = await createQueueFixture(context);
	await queue.enqueue({ id: "one", text: "source", signal: undefined });
	const claim = await queue.claim({ owner: "worker", signal: undefined });
	assert.ok(claim);
	const outcomes = await Promise.allSettled(["first", "second"].map(summary => queue.acknowledge({ ...claim, owner: "worker", result: { summary, quote: "source" }, signal: undefined })));
	assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
	const failed = outcomes.find(outcome => outcome.status === "rejected");
	assert.ok(failed?.status === "rejected");
	assert.match(String(failed.reason), /Conflicting queue result/);
	const snapshot = await queue.inspect();
	assert.equal(snapshot.acknowledged, 1);
	const [item] = snapshot.items;
	assert.equal(item.status, "acknowledged");
	if (item.status === "acknowledged") assert.ok(["first", "second"].includes(item.result.summary));
});

test("leases exclude competitors, repeat the current owner's claim, and fence expired deliveries", async context => {
	let now = 1000;
	const { queue } = await createQueueFixture(context, { now: () => now, leaseDurationMs: 100 });
	await queue.enqueue({ id: "item", text: "first note", signal: undefined });
	const first = await queue.claim({ owner: "first", signal: undefined });
	assert.ok(first);
	assert.deepEqual(await queue.claim({ owner: "first", signal: undefined }), first);
	assert.equal(await queue.claim({ owner: "second", signal: undefined }), null);
	await assert.rejects(queue.acknowledge({ ...first, owner: "second", result: { summary: "wrong owner", quote: "first note" }, signal: undefined }), /invalid queue lease/);
	now = 1100;
	await assert.rejects(queue.acknowledge({ ...first, owner: "first", result: { summary: "late", quote: "first note" }, signal: undefined }), /invalid queue lease/);
	assert.equal((await queue.inspect()).available, 1);
	const second = await queue.claim({ owner: "second", signal: undefined });
	assert.ok(second);
	assert.notEqual(second.token, first.token);
	assert.equal(second.deliveries, 2);
	await assert.rejects(queue.acknowledge({ ...first, owner: "first", result: { summary: "stale", quote: "first note" }, signal: undefined }), /invalid queue lease/);
	await queue.acknowledge({ ...second, owner: "second", result: { summary: "done", quote: "first note" }, signal: undefined });
	assert.deepEqual((await queue.inspect()).items, [{ id: "item", text: "first note", status: "acknowledged", result: { summary: "done", quote: "first note" }, deliveries: 2 }]);
});

test("note/result bounds and retained-history capacity fail without overwriting valid data", async context => {
	const { queue, path } = await createQueueFixture(context);
	await assert.rejects(queue.enqueue({ id: "bad", text: 3 as never, signal: undefined }));
	await assert.rejects(queue.enqueue({ id: "short", text: "tiny", signal: undefined }));
	await assert.rejects(queue.enqueue({ id: "big", text: "x".repeat(1001), signal: undefined }));
	for (let index = 0; index < 12; index++) await queue.enqueue({ id: `${index}`, text: `source ${index}`, signal: undefined });
	const claim = await queue.claim({ owner: "owner", signal: undefined });
	assert.ok(claim);
	const before = await readFile(path, "utf8");
	await assert.rejects(queue.acknowledge({ ...claim, owner: "owner", result: { summary: 1 as never, quote: "source" }, signal: undefined }));
	assert.equal(await readFile(path, "utf8"), before);
	await queue.acknowledge({ ...claim, owner: "owner", result: { summary: "complete", quote: "source" }, signal: undefined });
	await assert.rejects(queue.enqueue({ id: "overflow", text: "another", signal: undefined }), /at most 12 notes/);
	assert.equal((await queue.inspect()).items.length, 12);
});

test("a temporary-file collision preserves both the existing file and queue", async context => {
	const { queue, path, resources } = await createQueueFixture(context);
	const token = randomUUID();
	const temporary = `${path}.${token}.tmp`;
	await writeFile(temporary, "retained incomplete write");
	const colliding = new WorkQueue({ path, files: resources.files, leaseDurationMs: 1000, now: Date.now, createToken: () => token });
	await assert.rejects(colliding.enqueue({ id: "one", text: "source", signal: undefined }), { code: "EEXIST" });
	assert.equal(await readFile(temporary, "utf8"), "retained incomplete write");
	assert.equal((await queue.inspect()).items.length, 0);
});

test("initialized missing or malformed storage is never replaced with an empty queue", async context => {
	const { root, path, definition } = await createQueueFixture(context);
	for (const invalid of ["[]", '{"format":1,"items":[{}]}']) {
		await writeFile(path, invalid);
		await assert.rejects((await NornRunResources.initialize(root)).ensure(definition));
		assert.equal(await readFile(path, "utf8"), invalid);
	}
	await rm(path);
	await assert.rejects((await NornRunResources.initialize(root)).ensure(definition), { code: "ENOENT" });
	await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("creation retries retain partially initialized queue data", async context => {
	const { root, definition } = await createQueueFixture(context);
	const partial = { ...definition, name: "partial", async initialize(resource: Parameters<typeof definition.initialize>[0]) {
		const queue = await definition.initialize(resource);
		if (resource.mode === "create") {
			await queue.enqueue({ id: "saved", text: "retained", signal: undefined });
			throw new Error("interrupted before completion metadata");
		}
		return queue;
	} };
	await assert.rejects((await NornRunResources.initialize(root)).ensure(partial), /interrupted before completion/);
	const repaired = await (await NornRunResources.initialize(root)).ensure({ ...partial, initialize: definition.initialize });
	assert.equal((await repaired.inspect()).items[0].text, "retained");
});

test("mutation cancellation is checked after waiting for the process-safe lock", async context => {
	const { queue, path, resources } = await createQueueFixture(context);
	let entered!: () => void;
	let release!: () => void;
	const ready = new Promise<void>(resolve => { entered = resolve; });
	const released = new Promise<void>(resolve => { release = resolve; });
	const held = resources.files.withExclusiveLock(path, async () => { entered(); await released; });
	await ready;
	const controller = new AbortController();
	const writing = queue.enqueue({ id: "cancelled", text: "cancelled", signal: controller.signal });
	const rejected = assert.rejects(writing, /cancelled/);
	await delay(20);
	controller.abort(new Error("cancelled"));
	release();
	await Promise.all([held, rejected]);
	assert.equal((await queue.inspect()).items.length, 0);
	await queue.enqueue({ id: "next", text: "working", signal: undefined });
});

test("example adapter gives repeated labels separate claim owners and hides peer claims from status", async context => {
	const { queue } = await createQueueFixture(context);
	await queue.enqueue({ id: "one", text: "first note", signal: undefined });
	const adapter = QueueAdapter({ queue });
	const first = await adapter.bind({ runId: "test", label: "same-label" });
	const second = await adapter.bind({ runId: "test", label: "same-label" });
	const claimed = await invoke(first, { tool: "queue_claim", args: {} });
	const { claim } = claimed.details as { claim: { id: string; token: string } };
	const competing = await invoke(second, { tool: "queue_claim", args: {} });
	assert.deepEqual(competing.details, { claim: null });
	await assert.rejects(invoke(second, { tool: "queue_acknowledge", args: { ...claim, result: { summary: "stolen", quote: "first note" } } }), /invalid queue lease/);
	const status = await invoke(second, { tool: "queue_status", args: {} });
	assert.deepEqual(status.details, { available: 0, leased: 1, acknowledged: 0 });
	await first.dispose();
	await second.dispose();
	assert.equal((await queue.inspect()).leased, 1);
});

test("independent processes divide unexpired notes without duplicate claims", { timeout: 30000 }, async context => {
	const { root, queue } = await createQueueFixture(context);
	for (let index = 0; index < 12; index++) await queue.enqueue({ id: `${index}`, text: `source ${index}`, signal: undefined });
	await Promise.all(Array.from({ length: 4 }, (_, index) => startWorker(context, { root, mode: "consume", owner: `worker-${index}`, leaseDurationMs: 300_000 }).completed));
	const snapshot = await queue.inspect();
	assert.equal(snapshot.acknowledged, 12);
	for (const item of snapshot.items) {
		assert.equal(item.deliveries, 1);
		assert.equal(item.status, "acknowledged");
		if (item.status === "acknowledged") assert.deepEqual(item.result, { summary: item.text, quote: item.text });
	}
});

test("a killed worker's durable claim is redelivered at expiry with a fenced token", { timeout: 15000 }, async context => {
	let now = Date.now();
	const { root, queue } = await createQueueFixture(context, { now: () => now, leaseDurationMs: 1000 });
	await queue.enqueue({ id: "abandoned", text: "retry note", signal: undefined });
	const holder = startWorker(context, { root, mode: "hold", owner: "killed", leaseDurationMs: 1000 });
	const lines = createInterface({ input: holder.child.stdout });
	const line = await Promise.race([new Promise<string>(resolve => lines.once("line", resolve)), holder.completed.then(() => { throw new Error("Worker exited before claiming"); })]);
	lines.close();
	const original = JSON.parse(line) as { id: string; token: string; expiresAt: number };
	holder.child.kill("SIGKILL");
	await holder.completed;
	assert.equal((await queue.inspect()).leased, 1);
	now = original.expiresAt;
	const retry = await queue.claim({ owner: "replacement", signal: undefined });
	assert.ok(retry);
	assert.equal(retry.id, original.id);
	assert.equal(retry.deliveries, 2);
	assert.notEqual(retry.token, original.token);
	await assert.rejects(queue.acknowledge({ ...original, owner: "killed", result: { summary: "stale", quote: "retry note" }, signal: undefined }), /invalid queue lease/);
	await queue.acknowledge({ ...retry, owner: "replacement", result: { summary: "retained", quote: "retry note" }, signal: undefined });
});

test("checkpoint restore replays queue results and preserves lease expiry", async context => {
	let now = 1000;
	const { root, queue, definition } = await createQueueFixture(context, { now: () => now, leaseDurationMs: 100 });
	const store = await NornRunStore.initialize(root);
	await queue.enqueue({ id: "task", text: "source", signal: undefined });
	const old = await queue.claim({ owner: "old", signal: undefined });
	assert.ok(old);
	const checkpoint = await store.snapshotCurrent("leased");
	await queue.acknowledge({ ...old, owner: "old", result: { summary: "later", quote: "source" }, signal: undefined });
	await store.restoreSnapshot(checkpoint.id, undefined);
	const reopened = await (await NornRunResources.initialize(root)).ensure(definition);
	assert.equal((await reopened.inspect()).acknowledged, 0);
	assert.equal(await reopened.claim({ owner: "new", signal: undefined }), null);
	now = 1100;
	const fresh = await reopened.claim({ owner: "new", signal: undefined });
	assert.ok(fresh);
	assert.notEqual(fresh.token, old.token);
	await assert.rejects(reopened.acknowledge({ ...old, owner: "old", result: { summary: "old lineage", quote: "source" }, signal: undefined }), /invalid queue lease/);
});

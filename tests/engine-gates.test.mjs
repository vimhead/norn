import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJiti } from "jiti";
import { z } from "zod";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { definePlugin, definePluginManifest } = await jiti.import("../src/api.ts");
const { NornEngine } = await jiti.import("../src/internal/engine.ts");
const { writeRunResumeRequest, readOptionalRunResumeRequest } = await jiti.import("../src/internal/launch-request.ts");

async function createFixture(context, gateMode, isEntrypoint) {
	const cwd = await mkdtemp(join(tmpdir(), "norn-gate-test-"));
	context.after(() => rm(cwd, { recursive: true, force: true }));
	const manifest = definePluginManifest({ id: "gates", workflows: {
		decide: { title: "Decide", isEntrypoint, params: z.object({ answer: z.boolean() }), gate: { enabled: true, fields: ["answer"] } },
	} });
	let executionCount = 0;
	const engine = new NornEngine({ cwd, gateMode });
	engine.registerPlugin(definePlugin(manifest, { workflows: { decide: {
		gate: { describe: () => "Choose the answer before execution." },
		execute: (run, params) => { executionCount++; return run.complete({ data: params }); },
	} } }));
	return { cwd, engine, workflow: manifest.workflows.decide, count: () => executionCount };
}

for (const isEntrypoint of [true, false]) {
	test(`direct gated ${isEntrypoint ? "entrypoint" : "internal workflow"} pauses and executes only after resume`, async (context) => {
		const fixture = await createFixture(context, "pause", isEntrypoint);
		const interrupted = await fixture.engine.runWorkflow(fixture.workflow, { answer: false }, undefined);
		assert.equal(interrupted.status, "interrupted");
		assert.equal(fixture.count(), 0);
		const runRoot = join(fixture.cwd, ".norn/runs", interrupted.id);
		const completed = await fixture.engine.resumeWorkflow(runRoot, { answer: true });
		assert.equal(completed.status, "completed");
		assert.deepEqual(completed.metadata.data, { answer: true });
		assert.equal(fixture.count(), 1);
	});
}

for (const gateMode of ["auto", undefined]) {
	test(`direct gates execute in ${gateMode ?? "default"} mode`, async (context) => {
		const fixture = await createFixture(context, gateMode, true);
		assert.equal((await fixture.engine.runWorkflow(fixture.workflow, { answer: true }, undefined)).status, "completed");
		assert.equal(fixture.count(), 1);
	});
}

test("restoring the initial checkpoint cannot bypass a direct gate", async (context) => {
	const fixture = await createFixture(context, "pause", true);
	const interrupted = await fixture.engine.runWorkflow(fixture.workflow, { answer: false }, undefined);
	const runRoot = join(fixture.cwd, ".norn/runs", interrupted.id);
	const [initial] = await fixture.engine.listRunCheckpoints(runRoot);
	await fixture.engine.rollbackRun(runRoot, initial.id);
	assert.equal((await fixture.engine.resumeWorkflow(runRoot)).status, "interrupted");
	assert.equal(fixture.count(), 0);
});

test("rollback of a terminal checkpoint cannot discard dirty evidence", async context => {
	const fixture = await createFixture(context, "auto", true);
	const completed = await fixture.engine.runWorkflow(fixture.workflow, { answer: true }, undefined);
	const runRoot = join(fixture.cwd, ".norn/runs", completed.id);
	const checkpoints = await fixture.engine.listRunCheckpoints(runRoot);
	const evidence = join(runRoot, "current/after-completion.txt");
	await writeFile(evidence, "retain this");
	await assert.rejects(fixture.engine.rollbackRun(runRoot, checkpoints.at(-1).id), /without a current step/);
	assert.equal(await readFile(evidence, "utf8"), "retain this");
	assert.deepEqual(await fixture.engine.listRunCheckpoints(runRoot), checkpoints);
});

for (const isExpired of [false, true]) {
	test(`${isExpired ? "abandoned" : "fresh"} resume requests ${isExpired ? "can" : "cannot"} be cleared by rollback`, async context => {
		const fixture = await createFixture(context, "pause", true);
		const interrupted = await fixture.engine.runWorkflow(fixture.workflow, { answer: false }, undefined);
		const runRoot = join(fixture.cwd, ".norn/runs", interrupted.id);
		const [initial] = await fixture.engine.listRunCheckpoints(runRoot);
		const request = { version: 1, type: "resume", id: interrupted.id, requestId: "old-request", params: { answer: true }, createdAt: new Date(Date.now() - (isExpired ? 120000 : 0)).toISOString() };
		await writeRunResumeRequest(runRoot, request);
		if (isExpired) {
			assert.equal((await fixture.engine.rollbackRun(runRoot, initial.id)).status, "pendingResume");
			assert.equal(await readOptionalRunResumeRequest(runRoot), undefined);
			await assert.rejects(fixture.engine.resumeRequestedWorkflow({ runRoot, request }), /do not accept params|request changed/);
			assert.equal((await fixture.engine.resumeWorkflow(runRoot)).status, "interrupted");
		} else {
			await assert.rejects(fixture.engine.rollbackRun(runRoot, initial.id), /still pending/);
			await assert.rejects(fixture.engine.resumeWorkflow(runRoot, { answer: true }), /belongs to another executor/);
			await assert.rejects(fixture.engine.resumeRequestedWorkflow({ runRoot, request: { ...request, requestId: "wrong-request" } }), /request changed/);
			assert.equal((await fixture.engine.resumeRequestedWorkflow({ runRoot, request })).status, "completed");
		}
	});
}

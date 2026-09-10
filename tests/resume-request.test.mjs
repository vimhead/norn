import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { NornRunStateStore, getRunInfo } = await jiti.import("../src/internal/run-state.ts");
const { writeRunResumeRequest, readRunResumeRequest, clearRunResumeRequest, readOptionalRunResumeRequest } = await jiti.import("../src/internal/launch-request.ts");
const { NornRunLease } = await jiti.import("../src/internal/run-lease.ts");
const cliPath = fileURLToPath(new URL("../bin/norn.mjs", import.meta.url));

async function createFixture(context, status) {
	const cwd = await mkdtemp(join(tmpdir(), "norn-request-test-"));
	context.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "norn.project.json"), '{"version":1}');
	const runRoot = join(cwd, ".norn/runs/requested");
	await mkdir(runRoot, { recursive: true });
	const state = await NornRunStateStore.create(runRoot, {
		id: "requested", name: "requested", entrypointWorkflowId: "test.step", workspace: join(runRoot, "current/workspace"),
		current: { workflowId: "test.step", params: { answer: false }, cwd, env: {} }, startedAt: new Date().toISOString(),
	});
	if (status === "interrupted") await state.interruptCurrent({ answer: false }, { description: "Choose", fields: ["answer"] });
	else await state.prepareForResumeAfterRollback();
	const request = { version: 1, type: "resume", id: "requested", params: status === "interrupted" ? { answer: true } : undefined, createdAt: new Date().toISOString() };
	return { cwd, runRoot, state, request };
}

for (const status of ["interrupted", "pendingResume"]) {
	test(`queued resume hides old ${status} state and wait observes completion instead`, { timeout: 15000 }, async (context) => {
		const fixture = await createFixture(context, status);
		await writeRunResumeRequest(fixture.runRoot, fixture.request);
		const queued = await getRunInfo(fixture.runRoot);
		assert.equal(queued.status, "running");
		assert.equal(queued.health, "healthy");
		assert.equal(queued.interruption, undefined);
		const child = spawn(process.execPath, [cliPath, "runs", "wait", "requested"], { cwd: fixture.cwd, stdio: ["ignore", "pipe", "pipe"] });
		context.after(() => child.kill("SIGKILL"));
		let stdout = "";
		child.stdout.on("data", chunk => stdout += chunk);
		const closed = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
		await delay(1500);
		assert.equal(child.exitCode, null, stdout);
		await fixture.state.completeRun("test.step", { summary: "resumed work finished" });
		await rm(join(fixture.runRoot, "resume-request.json"));
		assert.equal(await closed, 0);
		assert.equal(JSON.parse(stdout).run.status, "completed");
	});
}

test("a second resume request cannot overwrite a queued decision", async (context) => {
	const fixture = await createFixture(context, "interrupted");
	await writeRunResumeRequest(fixture.runRoot, fixture.request);
	await assert.rejects(writeRunResumeRequest(fixture.runRoot, { ...fixture.request, params: { answer: false } }), { code: "EEXIST" });
	assert.deepEqual(await readRunResumeRequest(fixture.runRoot), fixture.request);
});

test("an abandoned resume request becomes unhealthy instead of waiting forever", async (context) => {
	const fixture = await createFixture(context, "pendingResume");
	await writeRunResumeRequest(fixture.runRoot, { ...fixture.request, createdAt: new Date(Date.now() - 120000).toISOString() });
	const info = await getRunInfo(fixture.runRoot);
	assert.equal(info.status, "running");
	assert.equal(info.health, "unhealthy");
});

test("an old executor cannot clear a replacement request", async context => {
	const fixture = await createFixture(context, "interrupted");
	const request = { ...fixture.request, requestId: "replacement" };
	await writeRunResumeRequest(fixture.runRoot, request);
	const lease = await NornRunLease.acquire(fixture.runRoot);
	try {
		await clearRunResumeRequest({ runRoot: fixture.runRoot, request: { ...request, requestId: "old" }, lease });
		assert.deepEqual(await readRunResumeRequest(fixture.runRoot), request);
		await clearRunResumeRequest({ runRoot: fixture.runRoot, request, lease });
		assert.equal(await readOptionalRunResumeRequest(fixture.runRoot), undefined);
	} finally {
		await lease.release();
	}
});

test("executor plugin-loading errors release the queued resume request", { timeout: 10000 }, async context => {
	const fixture = await createFixture(context, "interrupted");
	await writeFile(join(fixture.cwd, "norn.project.json"), '{"version":1,"plugins":["./broken.ts"]}');
	await writeFile(join(fixture.cwd, "broken.ts"), 'throw new Error("injected plugin loading failure");');
	await writeRunResumeRequest(fixture.runRoot, fixture.request);
	const child = spawn(process.execPath, [cliPath, "execute-run", "requested"], { cwd: fixture.cwd, stdio: ["ignore", "pipe", "pipe"] });
	context.after(() => child.kill("SIGKILL"));
	let stderr = "";
	let stdout = "";
	child.stderr.on("data", chunk => stderr += chunk);
	child.stdout.on("data", chunk => stdout += chunk);
	const exitCode = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
	assert.notEqual(exitCode, 0);
	assert.match(stderr || stdout, /injected plugin loading failure/);
	assert.equal(await readOptionalRunResumeRequest(fixture.runRoot), undefined);
	assert.equal((await getRunInfo(fixture.runRoot)).status, "interrupted");
});

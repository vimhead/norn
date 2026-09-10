import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { changeSupportProject, evaluateSupportStage, matchSupportRecords, prepareSupportProject } from "../scripts/support-trajectory-fixtures.mjs";
import { evaluateQueueStage, openQueueSink, prepareQueueProject } from "../scripts/queue-trajectory-fixtures.mjs";
import { evaluateSupportQueue, prepareSupportQueue } from "../scripts/support-queue-transfer.mjs";

const executeFile = promisify(execFile);
async function createDirectory(context) {
	const directory = await mkdtemp(join(tmpdir(), "norn-task-oracle-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

test("support outcomes do not infer entitlements from missing information", () => {
	const records = [{ id: "test", feed: "source" }];
	const expected = { test: ["unknown", "no", "manual"] };
	const correct = { id: "test", feed: "source", priority: "unknown", refund: "no", renewal: "manual" };
	assert.equal(matchSupportRecords({ actual: [correct], records, expected }), true);
	assert.equal(matchSupportRecords({ actual: [{ ...correct, priority: "no" }], records, expected }), false);
	assert.equal(matchSupportRecords({ actual: [correct, correct], records, expected }), false);
});

test("support correction changes only the affected feed and scoped policy", async context => {
	const cwd = await createDirectory(context);
	await prepareSupportProject({ cwd });
	const unchanged = await readFile(join(cwd, "feeds/Y.json"));
	await changeSupportProject({ cwd });
	assert.deepEqual(await readFile(join(cwd, "feeds/Y.json")), unchanged);
	assert.match(await readFile(join(cwd, "policy.txt"), "utf8"), /Feed X amendment only/);
	const checks = await evaluateSupportStage({ cwd, stage: 0 });
	assert.equal(checks.correctDelivery, false);
	assert.equal(checks.classifierGeneralizes, false);
});

test("an unattended support transfer cannot pass without retained assessment records", async context => {
	const cwd = await createDirectory(context);
	await prepareSupportQueue({ cwd });
	const first = JSON.parse(await readFile(join(cwd, "incoming/T1.json"), "utf8"));
	assert.equal(first.records.length, 2);
	assert.equal(first.records[0].feed, "T1");
	assert.equal((await evaluateSupportQueue({ cwd, stage: 0, environmentVariables: {} })).acceptedAssessmentsRetained, false);
});

test("queue delivery remains unavailable until the external sink recovers", async context => {
	const directory = await createDirectory(context);
	const seedRoot = join(directory, "seed");
	const cwd = join(directory, "project");
	await mkdir(seedRoot);
	await writeFile(join(seedRoot, "extract.mjs"), "export function classify(record) { return record; }");
	await writeFile(join(seedRoot, "policy.txt"), "Source-only fixture policy");
	await prepareQueueProject({ cwd, seedRoot });
	const records = [{ id: "Q1-1", feed: "Q1" }, { id: "Q1-2", feed: "Q1" }];
	await writeFile(join(cwd, "candidate.json"), JSON.stringify({ records }));
	for (let attempt = 0; attempt < 2; attempt++) {
		await assert.rejects(executeFile(process.execPath, ["tools/deliver.mjs", "candidate.json"], { cwd }), error => error.code === 75);
	}
	assert.equal((await evaluateQueueStage({ cwd, stage: 0, environmentVariables: {} })).acceptedAssessmentsRetained, false);
	await openQueueSink({ cwd });
	await executeFile(process.execPath, ["tools/deliver.mjs", "candidate.json"], { cwd });
	assert.deepEqual(JSON.parse(await readFile(join(cwd, "delivered/Q1.json"), "utf8")), { records });
});

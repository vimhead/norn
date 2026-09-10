import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { changeMetadataFeed, evaluateMetadataStage, matchRecords, prepareMetadataProject } from "../scripts/task-trajectory-fixtures.mjs";

const executeFile = promisify(execFile);
async function prepareProject(context) {
	const cwd = await mkdtemp(join(tmpdir(), "norn-trajectory-fixture-"));
	context.after(() => rm(cwd, { recursive: true, force: true }));
	await prepareMetadataProject({ cwd });
	return cwd;
}

test("ground-truth matching rejects missing, duplicate, cross-feed and incorrect facts", () => {
	const rows = [["A", "first", "source", "yes", "unknown", "no"]];
	const correct = { id: "A", feed: "first", vegan: "yes", organic: "unknown", caffeineFree: "no" };
	assert.equal(matchRecords({ actual: [correct], rows }), true);
	for (const actual of [[], [correct, correct], [{ ...correct, feed: "other" }], [{ ...correct, organic: "no" }]]) {
		assert.equal(matchRecords({ actual, rows }), false);
	}
});

test("changed evidence preserves the other feed's exact bytes", async context => {
	const cwd = await prepareProject(context);
	const before = await readFile(join(cwd, "feeds/B.json"));
	const firstA = await readFile(join(cwd, "feeds/A.json"));
	await changeMetadataFeed({ cwd });
	assert.deepEqual(await readFile(join(cwd, "feeds/B.json")), before);
	assert.notDeepEqual(await readFile(join(cwd, "feeds/A.json")), firstA);
	assert.match(await readFile(join(cwd, "policy.txt"), "utf8"), /Partner A amendment only/);
});

test("the flawed extractor and missing delivery fail the outcome oracle", async context => {
	const cwd = await prepareProject(context);
	const checks = await evaluateMetadataStage({ cwd, stage: 0 });
	assert.equal(checks.correctDelivery, false);
	assert.equal(checks.extractorGeneralizes, false);
});

test("local delivery fails before publication once and then accepts a retry", async context => {
	const cwd = await prepareProject(context);
	await writeFile(join(cwd, "candidate.json"), '{"records":[{"id":"test"}]}');
	const args = ["tools/publish.mjs", "candidate.json", "out/report.json"];
	await assert.rejects(executeFile(process.execPath, args, { cwd }), error => error.code === 75);
	await assert.rejects(readFile(join(cwd, "out/report.json")), error => error.code === "ENOENT");
	await executeFile(process.execPath, args, { cwd });
	assert.deepEqual(JSON.parse(await readFile(join(cwd, "out/report.json"), "utf8")), { records: [{ id: "test" }] });
	assert.equal((await readFile(join(cwd, "delivery-state/ledger.jsonl"), "utf8")).trim().split("\n").length, 2);
});

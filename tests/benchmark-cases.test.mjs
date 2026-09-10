import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { benchmarkCases } from "../scripts/benchmark-cases.mjs";

async function createProject(context) {
	const cwd = await mkdtemp(join(tmpdir(), "norn-benchmark-oracle-"));
	context.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "norn.project.json"), "{}");
	return cwd;
}

test("creation needs both saved normalized data and a resumable run", async context => {
	const cwd = await createProject(context);
	const runPath = join(cwd, ".norn/runs/run");
	await mkdir(join(runPath, "current/artifacts"), { recursive: true });
	await writeFile(join(runPath, "current/artifacts/normalized.json"), '["pear","apple"]');
	const evaluate = benchmarkCases.find(item => item.id === "create-during-task").evaluate;
	const checks = await evaluate({ cwd, cli: async ([resource]) => resource === "workflows"
		? { workflows: [{ id: "example.prepare" }] }
		: { runs: [{ path: runPath, status: "interrupted" }] } });
	assert.ok(Object.values(checks).every(Boolean));
	const noRun = await evaluate({ cwd, cli: async () => ({ workflows: [{ id: "example.prepare" }], runs: [] }) });
	assert.equal(noRun.resumableContinuation, false);
	assert.equal(noRun.normalizedEvidence, false);
});

test("a completed run does not satisfy the creation task's stop boundary", async context => {
	const cwd = await createProject(context);
	const evaluate = benchmarkCases.find(item => item.id === "create-during-task").evaluate;
	const checks = await evaluate({ cwd, cli: async () => ({ workflows: [{ id: "example.prepare" }], runs: [{ status: "completed" }] }) });
	assert.equal(checks.resumableContinuation, false);
	assert.equal(checks.noCompletedCountingRun, false);
});

test("repair rejects replacement evidence despite correct count", async context => {
	const cwd = await createProject(context);
	const evidencePath = join(cwd, "prepared.json");
	await writeFile(evidencePath, '{"identity":"replacement"}');
	const evaluate = benchmarkCases.find(item => item.id === "repair-existing-run").evaluate;
	const checks = await evaluate({
		fixture: { runId: "original", evidencePath, evidence: '{"identity":"original"}', identity: "original" },
		cli: async () => ({ run: { status: "completed", outcome: { metadata: { data: { count: 2, identity: "replacement" } } } }, runs: [{}] }),
	});
	assert.equal(checks.originalRunCompleted, true);
	assert.equal(checks.preparationPreserved, false);
	assert.equal(checks.correctReport, false);
	assert.equal(checks.preparedReferenceRetained, false);
});

test("repair accepts the original report and artifact reference", async context => {
	const cwd = await createProject(context);
	const evidencePath = join(cwd, "prepared.json");
	const evidence = '{"identity":"original"}';
	await writeFile(evidencePath, evidence);
	const evaluate = benchmarkCases.find(item => item.id === "repair-existing-run").evaluate;
	const checks = await evaluate({
		fixture: { runId: "original", evidencePath, evidence, identity: "original" },
		cli: async () => ({
			run: { status: "completed", outcome: { metadata: { data: { count: 2, identity: "original" }, artifacts: { evidence: { path: "prepared.json" } } } } },
			runs: [{}],
		}),
	});
	assert.ok(Object.values(checks).every(Boolean));
});

test("direct task rejects file creation even with a correct answer", async context => {
	const cwd = await createProject(context);
	const evaluate = benchmarkCases.find(item => item.id === "avoid-unnecessary-workflow").evaluate;
	const correct = await evaluate({ cwd, finalText: '["pear","apple"]' });
	assert.ok(Object.values(correct).every(Boolean));
	await writeFile(join(cwd, "unnecessary.ts"), "");
	const extraFile = await evaluate({ cwd, finalText: '["pear","apple"]' });
	assert.equal(extraFile.correctAnswer, true);
	assert.equal(extraFile.noNewFiles, false);
});

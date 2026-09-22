import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { AssertError } from "typebox/value";
import { test, type TestContext } from "vitest";

import { workflow, workflowScope } from "@vimhead.dev/norn";
import { NornEngine } from "../packages/cli/src/internal/engine.ts";
import { getRunLeaseOwner } from "../packages/cli/src/internal/run-lease.ts";
import { getRunInfo } from "../packages/cli/src/internal/run-state.ts";

async function createInterruptedRun(context: TestContext) {
	const cwd = await mkdtemp(join(tmpdir(), "norn-resume-test-"));
	context.onTestFinished(() => rm(cwd, { recursive: true, force: true }));
	const controller = new AbortController();
	const engine = new NornEngine({
		cwd,
		gateMode: "pause",
		signal: controller.signal,
	});
	const manifestScope = workflowScope({ name: "resumeTest" });
	const manifest_start = manifestScope.workflow({
		name: "start",
		entrypoint: { instructions: "Use to start a gated test run." },
		args: Type.Object({}),
		execute: () =>
			manifest_decision({ decision: "reject", evidence: "original" }),
	});
	const manifest_decision = manifestScope.workflow({
		name: "decision",
		entrypoint: false,
		args: Type.Object({
			decision: Type.Enum(["accept", "reject"]),
			evidence: Type.String(),
		}),
		gate: {
			enabled: true,
			fields: ["decision"],
			describe: () => "Accept or reject the evidence.",
		},
		execute: ({ args: args, run: run }) => {
			executionCount++;
			return run.complete({ data: args });
		},
	});
	let executionCount = 0;
	const plugin = [manifest_start, manifest_decision];
	const unregister = engine.registerWorkflows(plugin);
	const interrupted = await engine.runWorkflow(manifest_start, {}, undefined);
	assert.equal(interrupted.status, "interrupted");
	const runRoot = join(cwd, ".norn", "runs", interrupted.id);
	const initialRunInfo = await getRunInfo(runRoot);
	return {
		engine,
		plugin,
		unregister,
		runRoot,
		async assertRejectedResumeReleasedResources() {
			assert.equal(await getRunLeaseOwner(runRoot), undefined);
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
			assert.deepEqual(await getRunInfo(runRoot), initialRunInfo);
			assert.equal(executionCount, 0);
		},
		async assertCorrectedResumeCompletes() {
			const completed = await engine.resumeWorkflow(runRoot, {
				decision: "accept",
			});
			assert.equal(completed.status, "completed");
			assert.deepEqual(completed.metadata?.data, {
				decision: "accept",
				evidence: "original",
			});
			assert.equal(executionCount, 1);
			assert.equal(await getRunLeaseOwner(runRoot), undefined);
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		},
	};
}

for (const { name, args, error } of [
	{
		name: "protected-field patch",
		args: { evidence: "changed" },
		error: /non-gate fields/,
	},
	{
		name: "schema-invalid patch",
		args: { decision: "invalid" },
		error: AssertError,
	},
]) {
	test(`resume releases resources after a ${name} and accepts a corrected patch`, async (context) => {
		const fixture = await createInterruptedRun(context);
		await assert.rejects(
			fixture.engine.resumeWorkflow(fixture.runRoot, args),
			error,
		);
		await fixture.assertRejectedResumeReleasedResources();
		await fixture.assertCorrectedResumeCompletes();
	});
}

test("resume releases resources when the workflow is missing and succeeds after registration", async (context) => {
	const fixture = await createInterruptedRun(context);
	fixture.unregister();
	await assert.rejects(
		fixture.engine.resumeWorkflow(fixture.runRoot, { decision: "accept" }),
		/Unknown workflow for resumed run/,
	);
	await fixture.assertRejectedResumeReleasedResources();
	fixture.engine.registerWorkflows(fixture.plugin);
	await fixture.assertCorrectedResumeCompletes();
});

import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "vitest";
import { z } from "zod";

import { definePlugin, definePluginManifest } from "@vimhead.dev/norn";
import { NornEngine } from "../packages/cli/src/internal/engine.ts";
import { getRunInfo } from "../packages/cli/src/internal/run-state.ts";
import { getRunLeaseOwner } from "../packages/cli/src/internal/run-lease.ts";

async function createInterruptedRun(context: TestContext) {
	const cwd = await mkdtemp(join(tmpdir(), "norn-resume-test-"));
	context.onTestFinished(() => rm(cwd, { recursive: true, force: true }));
	const controller = new AbortController();
	const engine = new NornEngine({ cwd, gateMode: "pause", signal: controller.signal });
	const manifest = definePluginManifest({
		id: "resumeTest",
		workflows: {
			start: { isEntrypoint: true, instructions: "Use to start a gated test run.", params: z.object({}) },
			decision: {
				isEntrypoint: false,
				params: z.object({ decision: z.enum(["accept", "reject"]), evidence: z.string() }),
				gate: { enabled: true, fields: ["decision"] },
			},
		},
	});
	let executionCount = 0;
	const plugin = definePlugin(manifest, {
		workflows: {
			start: {
				execute: (run) => run.next(manifest.workflows.decision, { decision: "reject", evidence: "original" }),
			},
			decision: {
				gate: { describe: () => "Accept or reject the evidence." },
				execute: (run, params) => {
					executionCount++;
					return run.complete({ data: params });
				},
			},
		},
	});
	const unregister = engine.registerPlugin(plugin);
	const interrupted = await engine.runWorkflow(manifest.workflows.start, {}, undefined);
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
			const completed = await engine.resumeWorkflow(runRoot, { decision: "accept" });
			assert.equal(completed.status, "completed");
			assert.deepEqual(completed.metadata?.data, { decision: "accept", evidence: "original" });
			assert.equal(executionCount, 1);
			assert.equal(await getRunLeaseOwner(runRoot), undefined);
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		},
	};
}

for (const { name, params, error } of [
	{ name: "protected-field patch", params: { evidence: "changed" }, error: /non-gate fields/ },
	{ name: "schema-invalid patch", params: { decision: "invalid" }, error: /Invalid option/ },
]) {
	test(`resume releases resources after a ${name} and accepts a corrected patch`, async (context) => {
		const fixture = await createInterruptedRun(context);
		await assert.rejects(fixture.engine.resumeWorkflow(fixture.runRoot, params), error);
		await fixture.assertRejectedResumeReleasedResources();
		await fixture.assertCorrectedResumeCompletes();
	});
}

test("resume releases resources when the workflow is missing and succeeds after registration", async (context) => {
	const fixture = await createInterruptedRun(context);
	fixture.unregister();
	await assert.rejects(fixture.engine.resumeWorkflow(fixture.runRoot, { decision: "accept" }), /Unknown workflow for resumed run/);
	await fixture.assertRejectedResumeReleasedResources();
	fixture.engine.registerPlugin(fixture.plugin);
	await fixture.assertCorrectedResumeCompletes();
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin, definePluginManifest, workflowRefSchema, type NornRun, type NornWorkflowParams } from "@vimhead.dev/norn";
import { Type } from "typebox";
import { AssertError, Value } from "typebox/value";
import { test, type TestContext } from "vitest";
import { NornEngine } from "../packages/cli/src/internal/engine.ts";

const declarations = definePluginManifest({ id: "callables", workflows: {
	source: {
		isEntrypoint: true, instructions: "Choose a result handler or a direct target.",
		gate: { enabled: true, fields: ["outcome"] },
		params: Type.Object({
			outcome: Type.Enum(["success", "failure", "custom", "dynamic", "throw", "leak"]),
			next: Type.Object({
				success: workflowRefSchema({ params: Type.Object({ count: Type.String() }) }),
				failure: workflowRefSchema({ params: Type.Object({ reason: Type.String() }) }),
			}),
		}),
	},
	success: { isEntrypoint: false, params: Type.Object({ batchId: Type.String(), count: Type.Decode(Type.String(), text => Number(text) + 1) }) },
	failure: { isEntrypoint: false, params: Type.Object({ batchId: Type.String(), reason: Type.String() }) },
	custom: { isEntrypoint: false, isolation: { mode: "project" }, params: Type.Object({ reason: Type.String() }) },
	sink: { isEntrypoint: false, params: Type.Unknown() },
} });

const plugin = definePlugin(declarations, { workflows: {
	source: {
		gate: { describe: (_run, params) => `Handle ${params.outcome} with ${typeof params.next.success}` },
		execute: (run, params) => {
			switch (params.outcome) {
				case "success": return params.next.success({ count: "2" });
				case "failure": return params.next.failure({ reason: "rejected" });
				case "custom": return declarations.workflows.custom({ reason: "manual review" });
				case "dynamic": return run.next("callables.success", { batchId: "dynamic", count: "3" });
				case "throw": throw new Error("Unhandled producer failure");
				case "leak": return declarations.workflows.sink({ leaked: params.next.success });
			}
		},
	},
	success: { execute: (run, params) => run.complete({ data: { route: "success", ...params } }) },
	failure: { execute: (run, params) => run.complete({ data: { route: "failure", ...params } }) },
	custom: { execute: (run, params) => run.complete({ data: { route: "custom", projectContext: run.cwd === run.projectRoot, ...params } }) },
	sink: { execute: run => run.complete() },
} });

function input(outcome: "success" | "failure" | "custom" | "dynamic" | "throw" | "leak") {
	return { outcome, next: {
		success: { workflow: declarations.workflows.success.id, forwardParams: { batchId: "success-batch", count: "stale" } },
		failure: { workflow: declarations.workflows.failure.id, forwardParams: { batchId: "failure-batch" } },
	} };
}

async function fixture(context: TestContext, gateMode: "auto" | "pause") {
	const cwd = await mkdtemp(join(tmpdir(), "norn-callables-"));
	context.onTestFinished(() => rm(cwd, { recursive: true, force: true }));
	const engine = new NornEngine({ cwd, gateMode });
	engine.registerPlugin(plugin);
	return { cwd, engine };
}

for (const [outcome, expected] of [
	["success", { route: "success", batchId: "success-batch", count: 3 }],
	["failure", { route: "failure", batchId: "failure-batch", reason: "rejected" }],
	["custom", { route: "custom", projectContext: true, reason: "manual review" }],
	["dynamic", { route: "success", batchId: "dynamic", count: 4 }],
] as const) {
	test(`${outcome} routing uses the existing scheduler and target contract`, async context => {
		const { engine } = await fixture(context, "auto");
		const result = await engine.runWorkflow(declarations.workflows.source, input(outcome), undefined);
		assert.equal(result.status, "completed");
		assert.deepEqual(result.metadata?.data, expected);
	});
}

test("gate, resume, rollback and reopened execution reconstruct references from encoded input", async context => {
	const { cwd, engine } = await fixture(context, "pause");
	const wire = input("success");
	const paused = await engine.runWorkflow(declarations.workflows.source, wire, undefined);
	assert.equal(paused.status, "interrupted");
	assert.equal(paused.interruption?.description, "Handle success with function");
	assert.deepEqual(paused.interruption?.params, wire);
	const runRoot = join(cwd, ".norn/runs", paused.id);
	const saved = JSON.parse(await readFile(join(runRoot, "current/run-state.json"), "utf8"));
	assert.deepEqual(saved.current.params, wire);
	const checkpoints = await engine.listRunCheckpoints(runRoot);
	const reopened = new NornEngine({ cwd, gateMode: "pause" });
	reopened.registerPlugin(plugin);
	const failedBranch = await reopened.resumeWorkflow(runRoot, { outcome: "failure" });
	assert.equal(failedBranch.status, "completed");
	assert.deepEqual(failedBranch.metadata?.data, { route: "failure", batchId: "failure-batch", reason: "rejected" });
	await reopened.rollbackRun(runRoot, checkpoints[0].id);
	const replay = await reopened.resumeWorkflow(runRoot);
	assert.equal(replay.status, "interrupted");
	assert.deepEqual(replay.interruption?.params, wire);
	const success = await reopened.resumeWorkflow(runRoot, { outcome: "success" });
	assert.equal(success.status, "completed");
	assert.deepEqual(success.metadata?.data, { route: "success", batchId: "success-batch", count: 3 });
});

test("named failure handlers do not catch unhandled exceptions", async context => {
	const { engine } = await fixture(context, "auto");
	await assert.rejects(engine.runWorkflow(declarations.workflows.source, input("throw"), undefined), /Unhandled producer failure/);
});

test("reference invocation does not bypass target lookup or full input validation", async context => {
	const { engine } = await fixture(context, "auto");
	const missing = input("success");
	await assert.rejects(engine.runWorkflow(declarations.workflows.source, { ...missing, next: { ...missing.next, success: { workflow: "missing.target", forwardParams: {} } } }, undefined), /Unknown next workflow/);
	const invalid = { ...missing, next: { ...missing.next, success: { workflow: "callables.success", forwardParams: { batchId: {} } } } };
	await assert.rejects(engine.runWorkflow(declarations.workflows.source, invalid, undefined), AssertError);
});

test("decoded functions cannot silently disappear at persistence boundaries", async context => {
	const { engine } = await fixture(context, "auto");
	await assert.rejects(engine.runWorkflow(declarations.workflows.source, Value.Decode(declarations.workflows.source.params, input("success")), undefined), AssertError);
	await assert.rejects(engine.runWorkflow(declarations.workflows.source, input("leak"), undefined), AssertError);
});

function verifyBranchTypes(run: NornRun, params: NornWorkflowParams<typeof declarations.workflows.source>) {
	params.next.success({ count: "2" });
	params.next.failure({ reason: "rejected" });
	// @ts-expect-error Success and failure have distinct contribution contracts.
	params.next.success({ reason: "rejected" });
	// @ts-expect-error Known workflows require complete input.
	declarations.workflows.success({ count: "2" });
	// @ts-expect-error The target's input is encoded, not its decoded count.
	declarations.workflows.success({ batchId: "batch", count: 2 });
	// @ts-expect-error Dynamic calls take string IDs, not callable references.
	run.next(params.next.success, {});
}
void verifyBranchTypes;

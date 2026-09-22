import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	workflow,
	workflowScope,
	workflowRefSchema,
	type NornRun,
	type NornWorkflowArgs,
} from "@vimhead.dev/norn";
import { Type } from "typebox";
import { AssertError, Value } from "typebox/value";
import { test, type TestContext } from "vitest";
import { NornEngine } from "../packages/cli/src/internal/engine.ts";

const declarationsScope = workflowScope({ name: "callables" });
const declarations_source = declarationsScope.workflow({
	name: "source",
	entrypoint: { instructions: "Choose a result handler or a direct target." },
	gate: {
		enabled: true,
		fields: ["outcome"],
		describe: ({ args: args, run: _run }) =>
			`Handle ${args.outcome} with ${typeof args.next.success}`,
	},
	args: Type.Object({
		outcome: Type.Enum([
			"success",
			"failure",
			"custom",
			"dynamic",
			"throw",
			"leak",
		]),
		next: Type.Object({
			success: workflowRefSchema({
				args: Type.Object({ count: Type.String() }),
			}),
			failure: workflowRefSchema({
				args: Type.Object({ reason: Type.String() }),
			}),
		}),
	}),
	execute: ({ args: args, run: run }) => {
		switch (args.outcome) {
			case "success":
				return args.next.success({ count: "2" });
			case "failure":
				return args.next.failure({ reason: "rejected" });
			case "custom":
				return declarations_custom({ reason: "manual review" });
			case "dynamic":
				return run.next("callables.success", {
					batchId: "dynamic",
					count: "3",
				});
			case "throw":
				throw new Error("Unhandled producer failure");
			case "leak":
				return declarations_sink({ leaked: args.next.success });
		}
	},
});
const declarations_success = declarationsScope.workflow({
	name: "success",
	entrypoint: false,
	args: Type.Object({
		batchId: Type.String(),
		count: Type.Decode(Type.String(), (text) => Number(text) + 1),
	}),
	execute: ({ args: args, run: run }) =>
		run.complete({ data: { route: "success", ...args } }),
});
const declarations_failure = declarationsScope.workflow({
	name: "failure",
	entrypoint: false,
	args: Type.Object({ batchId: Type.String(), reason: Type.String() }),
	execute: ({ args: args, run: run }) =>
		run.complete({ data: { route: "failure", ...args } }),
});
const declarations_custom = declarationsScope.workflow({
	name: "custom",
	entrypoint: false,
	args: Type.Object({ reason: Type.String() }),
	execute: ({ args, run }) =>
		run.complete({ data: { route: "custom", ...args } }),
});
const declarations_sink = declarationsScope.workflow({
	name: "sink",
	entrypoint: false,
	args: Type.Unknown(),
	execute: ({ run: run }) => run.complete(),
});

const plugin = [
	declarations_source,
	declarations_success,
	declarations_failure,
	declarations_custom,
	declarations_sink,
];

function input(
	outcome: "success" | "failure" | "custom" | "dynamic" | "throw" | "leak",
) {
	return {
		outcome,
		next: {
			success: {
				workflow: declarations_success.id,
				forwardArgs: { batchId: "success-batch", count: "stale" },
			},
			failure: {
				workflow: declarations_failure.id,
				forwardArgs: { batchId: "failure-batch" },
			},
		},
	};
}

async function fixture(context: TestContext, gateMode: "auto" | "pause") {
	const cwd = await mkdtemp(join(tmpdir(), "norn-callables-"));
	context.onTestFinished(() => rm(cwd, { recursive: true, force: true }));
	const engine = new NornEngine({ cwd, gateMode });
	engine.registerWorkflows(plugin);
	return { cwd, engine };
}

for (const [outcome, expected] of [
	["success", { route: "success", batchId: "success-batch", count: 3 }],
	[
		"failure",
		{ route: "failure", batchId: "failure-batch", reason: "rejected" },
	],
	["custom", { route: "custom", reason: "manual review" }],
	["dynamic", { route: "success", batchId: "dynamic", count: 4 }],
] as const) {
	test(`${outcome} routing uses the existing scheduler and target contract`, async (context) => {
		const { engine } = await fixture(context, "auto");
		const result = await engine.runWorkflow(
			declarations_source,
			input(outcome),
			undefined,
		);
		assert.equal(result.status, "completed");
		assert.deepEqual(result.metadata?.data, expected);
	});
}

test("gate, resume, rollback and reopened execution reconstruct references from encoded input", async (context) => {
	const { cwd, engine } = await fixture(context, "pause");
	const wire = input("success");
	const paused = await engine.runWorkflow(declarations_source, wire, undefined);
	assert.equal(paused.status, "interrupted");
	assert.equal(
		paused.interruption?.description,
		"Handle success with function",
	);
	assert.deepEqual(paused.interruption?.args, wire);
	const runRoot = join(cwd, ".norn/runs", paused.id);
	const saved = JSON.parse(
		await readFile(join(runRoot, "current/run-state.json"), "utf8"),
	);
	assert.deepEqual(saved.current.args, wire);
	const checkpoints = await engine.listRunCheckpoints(runRoot);
	const reopened = new NornEngine({ cwd, gateMode: "pause" });
	reopened.registerWorkflows(plugin);
	const failedBranch = await reopened.resumeWorkflow(runRoot, {
		outcome: "failure",
	});
	assert.equal(failedBranch.status, "completed");
	assert.deepEqual(failedBranch.metadata?.data, {
		route: "failure",
		batchId: "failure-batch",
		reason: "rejected",
	});
	await reopened.rollbackRun(runRoot, checkpoints[0].id);
	const replay = await reopened.resumeWorkflow(runRoot);
	assert.equal(replay.status, "interrupted");
	assert.deepEqual(replay.interruption?.args, wire);
	const success = await reopened.resumeWorkflow(runRoot, {
		outcome: "success",
	});
	assert.equal(success.status, "completed");
	assert.deepEqual(success.metadata?.data, {
		route: "success",
		batchId: "success-batch",
		count: 3,
	});
});

test("named failure handlers do not catch unhandled exceptions", async (context) => {
	const { engine } = await fixture(context, "auto");
	await assert.rejects(
		engine.runWorkflow(declarations_source, input("throw"), undefined),
		/Unhandled producer failure/,
	);
});

test("reference invocation does not bypass target lookup or full input validation", async (context) => {
	const { engine } = await fixture(context, "auto");
	const missing = input("success");
	await assert.rejects(
		engine.runWorkflow(
			declarations_source,
			{
				...missing,
				next: {
					...missing.next,
					success: { workflow: "missing.target", forwardArgs: {} },
				},
			},
			undefined,
		),
		/Unknown next workflow/,
	);
	const invalid = {
		...missing,
		next: {
			...missing.next,
			success: { workflow: "callables.success", forwardArgs: { batchId: {} } },
		},
	};
	await assert.rejects(
		engine.runWorkflow(declarations_source, invalid, undefined),
		AssertError,
	);
});

test("decoded functions cannot silently disappear at persistence boundaries", async (context) => {
	const { engine } = await fixture(context, "auto");
	await assert.rejects(
		engine.runWorkflow(
			declarations_source,
			Value.Decode(declarations_source.args, input("success")),
			undefined,
		),
		AssertError,
	);
	await assert.rejects(
		engine.runWorkflow(declarations_source, input("leak"), undefined),
		AssertError,
	);
});

function verifyBranchTypes(
	run: NornRun,
	args: NornWorkflowArgs<typeof declarations_source>,
) {
	args.next.success({ count: "2" });
	args.next.failure({ reason: "rejected" });
	// @ts-expect-error Success and failure have distinct contribution contracts.
	args.next.success({ reason: "rejected" });
	// @ts-expect-error Known workflows require complete input.
	declarations_success({ count: "2" });
	// @ts-expect-error The target's input is encoded, not its decoded count.
	declarations_success({ batchId: "batch", count: 2 });
	// @ts-expect-error Dynamic calls take string IDs, not callable references.
	run.next(args.next.success, {});
}
void verifyBranchTypes;

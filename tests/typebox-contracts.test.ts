import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, type StaticDecode, type StaticEncode } from "typebox";
import { Value } from "typebox/value";
import { expectTypeOf, test, type TestContext } from "vitest";
import { workflow, workflowScope, workflowRefSchema, type NornRun, type NornWorkflowArgs, type NornWorkflowArgsInput, type WorkflowResult } from "@vimhead.dev/norn";
import { inspectSchema } from "@vimhead.dev/norn/schema";
import { NornAgentResponseCollector } from "../packages/cli/src/internal/agent-response-tool.ts";
import { NornEngine } from "../packages/cli/src/internal/engine.ts";
import { initializeSharedState } from "./helpers/shared-state.ts";

const incrementInput = Type.Decode(Type.Object({ count: Type.String() }), input => ({ count: Number(input.count) + 1 }));
const continuation = workflowRefSchema({ args: Type.Object({ report: Type.String() }) });
const step = workflow({
	id: "native.step", isEntrypoint: true, instructions: "Exercise native TypeBox contracts.", args: incrementInput,
	gate: { enabled: true, fields: ["count"], describe: ({ args }) => `Count ${args.count}` },
	execute(context) {
		expectTypeOf(context.args).toEqualTypeOf<{ count: number }>();
		expectTypeOf(context.config).toEqualTypeOf<undefined>();
		assert.equal("scope" in context, false);
		return context.run.complete({ data: context.args });
	},
});
async function fixture(context: TestContext) {
	const cwd = await mkdtemp(join(tmpdir(), "norn-typebox-"));
	context.onTestFinished(() => rm(cwd, { recursive: true, force: true }));
	return cwd;
}
test("native inference preserves encoded input, decoded output and explicit IDs", () => {
	expectTypeOf(step.id).toEqualTypeOf<"native.step">();
	expectTypeOf<NornWorkflowArgsInput<typeof step>>().toEqualTypeOf<{ count: string }>();
	expectTypeOf<NornWorkflowArgs<typeof step>>().toEqualTypeOf<{ count: number }>();
});
function verifyAuthoringTypes(run: NornRun, reference: StaticDecode<typeof continuation>) {
	step({ count: "2" });
	// @ts-expect-error Callers supply encoded arguments.
	step({ count: 2 });
	// @ts-expect-error Complete arguments are required.
	step({});
	run.next(step.id, { count: "2" });
	// @ts-expect-error Dynamic transitions take string IDs.
	run.next(step, {});
	reference({ report: "finished" });
	// @ts-expect-error Contributions are required.
	reference({});
	// @ts-expect-error Contributions retain their schema types.
	reference({ report: 42 });
	workflow({ id: "bad", isEntrypoint: false, args: incrementInput,
		// @ts-expect-error Gate fields address encoded argument properties.
		gate: { enabled: true, fields: ["missing"] }, execute: ({ run }) => run.complete(),
	});
	workflow({ id: "standalone", isEntrypoint: false, args: Type.Object({}), execute(context) {
		// @ts-expect-error Standalone contexts do not have a scope property.
		context.scope;
		expectTypeOf(context.paths.project).toEqualTypeOf<string>();
		expectTypeOf(context.paths.run).toEqualTypeOf<string>();
		// @ts-expect-error Commands require an explicit working directory.
		context.run.commands.run({ label: "check", command: ["pwd"] });
		// @ts-expect-error Agent sessions require an explicit working directory.
		context.run.agents.createSession({ label: "check" });
		return context.run.complete();
	} });
	const scope = workflowScope({ id: "empty" });
	scope.workflow({ id: "project", isEntrypoint: false, args: Type.Object({}), execute({ config, scope, paths, run }) {
		expectTypeOf(config).toEqualTypeOf<undefined>();
		expectTypeOf(scope.config).toEqualTypeOf<undefined>();
		expectTypeOf(scope.id).toEqualTypeOf<"empty">();
		expectTypeOf(paths.project).toEqualTypeOf<string>();
		expectTypeOf(paths.run).toEqualTypeOf<string>();
		return run.complete();
	} });
}
void verifyAuthoringTypes;

test("recursive workflows retain inferred context with a result annotation", async context => {
	const repeat = workflow({ id: "repeat", isEntrypoint: false, args: Type.Object({ count: Type.Integer() }),
		execute({ args, run }): WorkflowResult { return args.count ? repeat({ count: args.count - 1 }) : run.complete(); },
	});
	const engine = new NornEngine({ cwd: await fixture(context) });
	engine.registerWorkflows([repeat]);
	assert.equal((await engine.runWorkflow(repeat, { count: 2 }, undefined)).status, "completed");
});

test("native defaults remain annotations while codecs infer their output independently", () => {
	const schema = Type.Decode(Type.Object({ count: Type.Optional(Type.Integer({ default: 3 })) }), input => ({ count: input.count ?? 3 }));
	expectTypeOf<StaticEncode<typeof schema>>().toEqualTypeOf<{ count?: number }>();
	expectTypeOf<StaticDecode<typeof schema>>().toEqualTypeOf<{ count: number }>();
	assert.deepEqual(Value.Decode(schema, {}), { count: 3 });
	assert.equal(inspectSchema(schema).required, undefined);
});

test("gates and resumed executions decode inputs without persisting transformed values", async context => {
	const cwd = await fixture(context);
	const engine = new NornEngine({ cwd, gateMode: "pause" });
	engine.registerWorkflows([step]);
	const interrupted = await engine.runWorkflow(step, { count: "2" }, undefined);
	assert.equal(interrupted.status, "interrupted");
	assert.deepEqual(interrupted.interruption?.args, { count: "2" });
	assert.equal(interrupted.interruption?.description, "Count 3");
	const runRoot = join(cwd, ".norn/runs", interrupted.id);
	const completed = await engine.resumeWorkflow(runRoot, { count: "4" });
	assert.equal(completed.status, "completed");
	assert.deepEqual(completed.metadata?.data, { count: 5 });
	const checkpoints = await engine.listRunCheckpoints(runRoot);
	await engine.rollbackRun(runRoot, checkpoints[0].id);
	const reopened = new NornEngine({ cwd, gateMode: "pause" });
	reopened.registerWorkflows([step]);
	const replayed = await reopened.resumeWorkflow(runRoot);
	assert.equal(replayed.status, "interrupted");
	assert.equal(replayed.interruption?.description, "Count 3");
	assert.deepEqual(replayed.interruption?.args, { count: "2" });
	assert.ok((await readFile(join(runRoot, "current/run-state.json"), "utf8")).includes('"2"'));
});

test("workflow arguments use conversion, defaults and cleaning", async context => {
	const decode = workflow({ id: "decode", isEntrypoint: false, args: Type.Object({ count: Type.Integer({ default: 3 }) }, { additionalProperties: false }), execute: ({ args, run }) => run.complete({ data: args }) });
	const engine = new NornEngine({ cwd: await fixture(context) });
	engine.registerWorkflows([decode]);
	for (const [input, expected] of [[{}, 3], [{ count: "4", extra: "removed" }, 4]] as const) {
		const result = await engine.runWorkflow(decode, input, undefined);
		assert.equal(result.status, "completed");
		assert.deepEqual(result.metadata?.data, { count: expected });
	}
});

test("workflow and scope configurations decode and override independently, including gates", async context => {
	const schema = Type.Object({ count: Type.Decode(Type.String(), text => Number(text) + 1), label: Type.String() });
	const reports = workflowScope({ id: "reports", config: schema });
	const summarize = reports.workflow({ id: "summarize", isEntrypoint: false, args: Type.Object({ approved: Type.Boolean() }), config: schema,
		gate: { enabled: true, fields: ["approved"], describe({ config, scope }) {
			expectTypeOf(config.count).toEqualTypeOf<number>();
			expectTypeOf(scope.config.count).toEqualTypeOf<number>();
			return `${config.count}/${scope.config.count}`;
		} },
		execute({ config, scope, run }) { return run.complete({ data: { local: config, shared: scope.config } }); },
	});
	const cwd = await fixture(context);
	const engine = new NornEngine({ cwd, gateMode: "pause", config: { reports: { count: "2", label: "shared" }, "reports.summarize": { count: "5", label: "local" } } });
	engine.registerWorkflows([summarize]);
	const result = await engine.runWorkflow(summarize, { approved: false }, { configOverride: { reports: { label: "shared override" }, "reports.summarize": { label: "local override" } } });
	assert.equal(result.status, "interrupted");
	assert.equal(result.interruption?.description, "6/3");
	const completed = await engine.resumeWorkflow(join(cwd, ".norn/runs", result.id), { approved: true });
	assert.equal(completed.status, "completed");
	assert.deepEqual(completed.metadata?.data, { local: { count: 6, label: "local override" }, shared: { count: 3, label: "shared override" } });
});

test("example shared storage validates values without decoding codecs or initializing defaults", async context => {
	const { state } = await initializeSharedState(await fixture(context));
	const field = { id: "count", schema: Type.Decode(Type.String(), text => Number(text) + 1) };
	await state.set(field, "2");
	assert.equal(await state.get(field), "2");
	await assert.rejects(state.set({ id: "json", schema: Type.Unknown() }, { invalid: new Date() }));
	assert.equal(await state.getOptional({ id: "missing", schema: Type.Integer({ default: 3 }) }), undefined);
	await assert.rejects(state.set({ id: "integer", schema: Type.Integer() }, "3" as unknown as number));
});

test("response capture applies native codecs once and retains validation failures", () => {
	const collector = new NornAgentResponseCollector();
	const dispose = collector.begin("run", "step", incrementInput);
	assert.deepEqual(collector.capture("run", "step", { count: "2" }), { label: "step", response: { count: 3 } });
	assert.deepEqual(collector.get("run"), { called: true, response: { count: 3 } });
	dispose();
	collector.begin("invalid", "step", Type.Object({ count: Type.Integer() }));
	assert.throws(() => collector.capture("invalid", "step", { count: "not a number" }));
	assert.deepEqual(collector.get("invalid"), { called: false, response: undefined });
});

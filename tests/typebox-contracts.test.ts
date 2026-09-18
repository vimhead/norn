import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, type StaticDecode, type StaticEncode } from "typebox";
import { Value } from "typebox/value";
import { expectTypeOf, test, type TestContext } from "vitest";
import { definePlugin, definePluginManifest, workflowRefSchema, type NornRun, type NornWorkflowParams, type NornWorkflowParamsInput, type NornWorkflowPluginConfig } from "@vimhead.dev/norn";
import { inspectSchema } from "@vimhead.dev/norn/schema";
import { NornAgentResponseCollector } from "../packages/cli/src/internal/agent-response-tool.ts";
import { NornEngine } from "../packages/cli/src/internal/engine.ts";
import { NornMemoryWorkflowState } from "../packages/cli/src/internal/state-store.ts";

const incrementInput = Type.Decode(Type.Object({ count: Type.String() }), input => ({ count: Number(input.count) + 1 }));
const continuation = workflowRefSchema({ params: Type.Object({ report: Type.String() }) });
const manifest = definePluginManifest({
	id: "native",
	workflows: { step: { isEntrypoint: true, instructions: "Exercise native TypeBox contracts.", params: incrementInput, gate: { enabled: true, fields: ["count"] } } },
	states: {
		count: Type.Integer(),
		nested: { flag: Type.Boolean(), schema: { leaf: Type.String() } },
		schema: Type.String(),
		custom: { id: "native.explicit", description: "Named state", schema: Type.String() },
		unsafe: Type.Unsafe<string>({ type: "string" }),
	},
});

async function fixture(context: TestContext) {
	const cwd = await mkdtemp(join(tmpdir(), "norn-typebox-"));
	context.onTestFinished(() => rm(cwd, { recursive: true, force: true }));
	return cwd;
}

test("native schema inference preserves input/output, direct state leaves and explicit IDs", () => {
	expectTypeOf<NornWorkflowPluginConfig<typeof manifest>>().toEqualTypeOf<undefined>();
	expectTypeOf<NornWorkflowParamsInput<typeof manifest.workflows.step>>().toEqualTypeOf<{ count: string }>();
	expectTypeOf<NornWorkflowParams<typeof manifest.workflows.step>>().toEqualTypeOf<{ count: number }>();
	expectTypeOf(manifest.states.count.id).toEqualTypeOf<"native.count">();
	expectTypeOf(manifest.states.nested.flag.id).toEqualTypeOf<"native.nested.flag">();
	expectTypeOf(manifest.states.nested.schema.leaf.id).toEqualTypeOf<"native.nested.schema.leaf">();
	assert.equal(manifest.states.nested.schema.leaf.id, "native.nested.schema.leaf");
	expectTypeOf(manifest.states.custom.id).toEqualTypeOf<"native.explicit">();
	assert.equal(manifest.states.schema.id, "native.schema");
	assert.equal(manifest.states.unsafe.id, "native.unsafe");
	assert.equal(manifest.states.custom.description, "Named state");
	assert.equal(Value.Check(manifest.states.nested.flag.schema, true), true);
});

function verifyAuthoringTypes(run: NornRun, reference: StaticDecode<typeof continuation>) {
	run.next(manifest.workflows.step, { count: "2" });
	// @ts-expect-error Workflow callers supply the encoded type.
	run.next(manifest.workflows.step, { count: 2 });
	run.next(reference.workflow, { ...reference.forwardParams, report: "finished" });
	// @ts-expect-error Continuations require the declared contribution.
	run.next(reference.workflow, { ...reference.forwardParams });
	// @ts-expect-error Continuations retain their caller's forwarded parameters.
	run.next(reference.workflow, { report: "finished" });
	run.state.set(manifest.states.count, 2);
	// @ts-expect-error State values match their native schema's encoded type.
	run.state.set(manifest.states.count, "2");
	expectTypeOf(run.state.get(manifest.states.count)).toEqualTypeOf<Promise<number>>();
	expectTypeOf(run.state.getOptional(manifest.states.nested.flag)).toEqualTypeOf<Promise<boolean | undefined>>();
	// @ts-expect-error Gate fields refer to actual encoded input properties.
	definePluginManifest({ id: "bad", workflows: { step: { isEntrypoint: false, params: incrementInput, gate: { enabled: true, fields: ["missing"] } } } });
}
void verifyAuthoringTypes;

test("native defaults remain annotations while codecs infer their output independently", () => {
	const schema = Type.Decode(Type.Object({ count: Type.Optional(Type.Integer({ default: 3 })) }), input => ({ count: input.count ?? 3 }));
	expectTypeOf<StaticEncode<typeof schema>>().toEqualTypeOf<{ count?: number }>();
	expectTypeOf<StaticDecode<typeof schema>>().toEqualTypeOf<{ count: number }>();
	assert.deepEqual(Value.Decode(schema, {}), { count: 3 });
	assert.equal(inspectSchema(schema).required, undefined);
});

test("gates and resumed executions decode encoded inputs without persisting transformed values", async context => {
	const cwd = await fixture(context);
	const engine = new NornEngine({ cwd, gateMode: "pause" });
	engine.registerPlugin(definePlugin(manifest, { workflows: { step: {
		gate: { describe: (_run, params) => `Count ${params.count}` },
		execute: (run, params) => run.complete({ data: params }),
	} } }));
	const interrupted = await engine.runWorkflow(manifest.workflows.step, { count: "2" }, undefined);
	assert.equal(interrupted.status, "interrupted");
	assert.deepEqual(interrupted.interruption?.params, { count: "2" });
	assert.equal(interrupted.interruption?.description, "Count 3");
	const runRoot = join(cwd, ".norn/runs", interrupted.id);
	const completed = await engine.resumeWorkflow(runRoot, { count: "4" });
	assert.equal(completed.status, "completed");
	assert.deepEqual(completed.metadata?.data, { count: 5 });
	const checkpoints = await engine.listRunCheckpoints(runRoot);
	await engine.rollbackRun(runRoot, checkpoints[0].id);
	const reopened = new NornEngine({ cwd, gateMode: "pause" });
	reopened.registerPlugin(definePlugin(manifest, { workflows: { step: {
		gate: { describe: (_run, params) => `Count ${params.count}` },
		execute: (run, params) => run.complete({ data: params }),
	} } }));
	const replayed = await reopened.resumeWorkflow(runRoot);
	assert.equal(replayed.status, "interrupted");
	assert.equal(replayed.interruption?.description, "Count 3");
	assert.deepEqual(replayed.interruption?.params, { count: "2" });
	assert.ok((await readFile(join(runRoot, "current/run-state.json"), "utf8")).includes('"2"'));
});

test("workflow inputs use TypeBox decoding, including conversion, defaults and cleaning", async context => {
	const cwd = await fixture(context);
	const declarations = definePluginManifest({ id: "decode", workflows: {
		step: { isEntrypoint: false, params: Type.Object({ count: Type.Integer({ default: 3 }) }, { additionalProperties: false }) },
	} });
	const engine = new NornEngine({ cwd });
	engine.registerPlugin(definePlugin(declarations, { workflows: { step: { execute: (run, params) => run.complete({ data: params }) } } }));
	for (const [input, expected] of [[{}, 3], [{ count: "4", extra: "removed" }, 4]] as const) {
		const result = await engine.runWorkflow(declarations.workflows.step, input, undefined);
		assert.equal(result.status, "completed");
		assert.deepEqual(result.metadata?.data, { count: expected });
	}
});

test("plugin overrides merge encoded configuration rather than decoded outputs", async context => {
	const cwd = await fixture(context);
	const declarations = definePluginManifest({ id: "config", config: Type.Object({ count: Type.Decode(Type.String(), text => Number(text) + 1), label: Type.String() }), workflows: {
		step: { isEntrypoint: false, params: Type.Object({}) },
	} });
	const engine = new NornEngine({ cwd, config: { config: { count: "2", label: "base" } } });
	engine.registerPlugin(definePlugin(declarations, { workflows: { step: { execute: (run, _params, config) => run.complete({ data: config }) } } }));
	const result = await engine.runWorkflow(declarations.workflows.step, {}, { configOverride: { config: { label: "override" } } });
	assert.equal(result.status, "completed");
	assert.deepEqual(result.metadata?.data, { count: 3, label: "override" });
});

test("state validates JSON values and does not run input codecs or invent missing defaults", async () => {
	const state = new NornMemoryWorkflowState();
	const field = { id: "count", schema: Type.Decode(Type.String(), text => Number(text) + 1) };
	await state.set(field, "2");
	assert.equal(await state.get(field), "2");
	await assert.rejects(state.set({ id: "json", schema: Type.Unknown() }, { invalid: new Date() }));
	assert.equal(await state.getOptional({ id: "missing", schema: Type.Integer({ default: 3 }) }), undefined);
	await assert.rejects(state.set(manifest.states.count, "3" as unknown as number));
});

test("response capture applies native codecs once and retains native validation failures", () => {
	const collector = new NornAgentResponseCollector();
	const dispose = collector.begin("run", "step", incrementInput);
	assert.deepEqual(collector.capture("run", "step", { count: "2" }), { label: "step", response: { count: 3 } });
	assert.deepEqual(collector.get("run"), { called: true, response: { count: 3 } });
	dispose();
	collector.begin("invalid", "step", Type.Object({ count: Type.Integer() }));
	assert.throws(() => collector.capture("invalid", "step", { count: "not a number" }));
	assert.deepEqual(collector.get("invalid"), { called: false, response: undefined });
});

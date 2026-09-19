import assert from "node:assert/strict";
import { Type } from "typebox";
import { test } from "vitest";
import { workflow, type NornAnyWorkflowDeclaration, type NornRun } from "@vimhead.dev/norn";
import { NornWorkflowRegistry } from "../packages/cli/src/internal/workflow-registry.ts";

function createWorkflow({ instructions, isEntrypoint = true, gate }: { instructions?: unknown; isEntrypoint?: boolean; gate?: { enabled: true; describe?: () => string } }) {
	const definition = workflow({ id: "metadata.step", isEntrypoint: true, instructions: "Fixture instructions", args: Type.Object({}), gate, execute: ({ run }) => run.complete() });
	Reflect.set(definition, "isEntrypoint", isEntrypoint);
	Reflect.set(definition, "instructions", instructions);
	return definition;
}
function register(registry: NornWorkflowRegistry, workflow: NornAnyWorkflowDeclaration) { return registry.register({ workflow, config: {}, source: undefined }); }
function unexpectedRunOperation(): never { throw new Error("These gate descriptions must not invoke run operations"); }
const run: NornRun = {
	id: "metadata",
	next: unexpectedRunOperation, complete: unexpectedRunOperation, fail: unexpectedRunOperation,
	logs: { read: unexpectedRunOperation }, commands: { run: unexpectedRunOperation },
	agents: { createSession: unexpectedRunOperation, prompt: unexpectedRunOperation },
};
for (const instructions of [undefined, "", " \n\t ", null, 42]) {
	test(`entrypoints reject invalid instructions: ${JSON.stringify(instructions)}`, () => {
		const registry = new NornWorkflowRegistry();
		assert.throws(() => register(registry, createWorkflow({ instructions })), /instructions/);
		assert.deepEqual(registry.list(), []);
	});
}
test("internal steps may omit instructions but supplied instructions must be nonempty", () => {
	const registry = new NornWorkflowRegistry();
	const definition = createWorkflow({ isEntrypoint: false });
	register(registry, definition);
	assert.equal(registry.inspect(definition.id)?.instructions, undefined);
	for (const instructions of ["", " \n ", null, 42]) assert.throws(() => register(new NornWorkflowRegistry(), createWorkflow({ isEntrypoint: false, instructions })), /instructions/);
});
test("discovery sorts IDs and publishes caller instructions and config ownership", () => {
	const definitions = [
		workflow({ id: "metadata.zebra", isEntrypoint: true, instructions: "Alpha guidance for the last workflow.", args: Type.Object({}), execute: ({ run }) => run.complete() }),
		workflow({ id: "metadata.middle", isEntrypoint: false, args: Type.Object({}), execute: ({ run }) => run.complete() }),
		workflow({ id: "metadata.alpha", isEntrypoint: true, instructions: "Zebra guidance for the first workflow.", args: Type.Object({}), execute: ({ run }) => run.complete() }),
	];
	const registry = new NornWorkflowRegistry();
	for (const definition of definitions) register(registry, definition);
	assert.deepEqual(registry.list().map(workflow => workflow.id), ["metadata.alpha", "metadata.middle", "metadata.zebra"]);
	assert.deepEqual(registry.list({ entrypointsOnly: true }).map(workflow => [workflow.id, workflow.configKey]), [["metadata.alpha", "metadata.alpha"], ["metadata.zebra", "metadata.zebra"]]);
	assert.equal(registry.inspect("metadata.alpha")?.instructions, "Zebra guidance for the first workflow.");
});
test("gate fallback is the workflow ID, not caller instructions", async () => {
	const registry = new NornWorkflowRegistry();
	const definition = createWorkflow({ instructions: "Use to collect records, not as a gate decision request.", gate: { enabled: true } });
	register(registry, definition);
	assert.equal(await registry.describeGate({ workflow: definition, run, paths: { project: "/project", workspace: "/workspace" }, args: {}, configOverride: undefined }), definition.id);
});
test("gate descriptions remain independent from caller instructions", async () => {
	const registry = new NornWorkflowRegistry();
	const definition = createWorkflow({ instructions: "Use to collect records.", gate: { enabled: true, describe: () => "Check the collected evidence before proceeding." } });
	register(registry, definition);
	assert.equal(await registry.describeGate({ workflow: definition, run, paths: { project: "/project", workspace: "/workspace" }, args: {}, configOverride: undefined }), "Check the collected evidence before proceeding.");
	assert.equal(registry.inspect(definition.id)?.instructions, "Use to collect records.");
});

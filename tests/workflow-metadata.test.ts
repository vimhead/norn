import assert from "node:assert/strict";
import { Type } from "typebox";
import { test } from "vitest";
import {
	isWorkflowDeclaration,
	workflow,
	workflowScope,
	type NornAnyWorkflowDeclaration,
	type NornWorkflowContext,
	type NornWorkflowEntrypoint,
} from "@vimhead.dev/norn";
import { NornWorkflowRegistry } from "../packages/cli/src/internal/workflow-registry.ts";

const metadata = workflowScope({ name: "metadata" });

function createWorkflow({
	entrypoint,
	gate,
}: {
	entrypoint: NornWorkflowEntrypoint;
	gate?: { enabled: true; describe?: () => string };
}) {
	return metadata.workflow({
		name: "step",
		entrypoint,
		args: Type.Object({}),
		gate,
		execute: ({ run }) => run.complete(),
	});
}
function register(
	registry: NornWorkflowRegistry,
	workflow: NornAnyWorkflowDeclaration,
) {
	return registry.register({ workflow, config: {}, source: undefined });
}
function unexpectedRunOperation(): never {
	throw new Error("These gate descriptions must not invoke run operations");
}
const execution: Pick<
	NornWorkflowContext,
	"run" | "agents" | "commands" | "logs"
> = {
	run: {
		id: "metadata",
		next: unexpectedRunOperation,
		complete: unexpectedRunOperation,
		fail: unexpectedRunOperation,
	},
	logs: { read: unexpectedRunOperation },
	commands: { run: unexpectedRunOperation },
	agents: {
		createSession: unexpectedRunOperation,
		prompt: unexpectedRunOperation,
	},
};
for (const entrypoint of [
	undefined,
	null,
	true,
	"",
	"instructions",
	42,
	[],
	{},
	{ instructions: undefined },
	{ instructions: "" },
	{ instructions: " \n\t " },
	{ instructions: null },
	{ instructions: 42 },
]) {
	test(`entrypoint declarations and registration reject invalid metadata: ${JSON.stringify(entrypoint)}`, () => {
		assert.throws(
			() =>
				workflow({
					name: "invalid",
					entrypoint: entrypoint as NornWorkflowEntrypoint,
					args: Type.Object({}),
					execute: ({ run }) => run.complete(),
				}),
			/entrypoint/,
		);
		assert.throws(
			() =>
				createWorkflow({ entrypoint: entrypoint as NornWorkflowEntrypoint }),
			/entrypoint/,
		);
		const definition = createWorkflow({
			entrypoint: { instructions: "Use to complete the fixture." },
		});
		Reflect.set(definition, "entrypoint", entrypoint);
		const registry = new NornWorkflowRegistry();
		assert.throws(() => register(registry, definition), /entrypoint/);
		assert.deepEqual(registry.list(), []);
	});
}
test("internal steps explicitly opt out of default discovery without caller instructions", () => {
	const registry = new NornWorkflowRegistry();
	const definition = createWorkflow({ entrypoint: false });
	assert.equal(definition.entrypoint, false);
	assert.equal(isWorkflowDeclaration(definition), true);
	register(registry, definition);
	assert.equal(registry.inspect(definition.id)?.isEntrypoint, false);
	assert.equal(registry.inspect(definition.id)?.instructions, undefined);
	assert.deepEqual(registry.list({ entrypointsOnly: true }), []);
	assert.deepEqual(
		registry.list().map((workflow) => workflow.id),
		[definition.id],
	);
	assert.deepEqual(definition({}), {
		type: "next",
		workflowId: definition.id,
		args: {},
	});
});
test("discovery sorts IDs and publishes caller instructions and config ownership", () => {
	const definitions = [
		metadata.workflow({
			name: "zebra",
			entrypoint: { instructions: "Alpha guidance for the last workflow." },
			args: Type.Object({}),
			execute: ({ run }) => run.complete(),
		}),
		metadata.workflow({
			name: "middle",
			entrypoint: false,
			args: Type.Object({}),
			execute: ({ run }) => run.complete(),
		}),
		metadata.workflow({
			name: "alpha",
			entrypoint: { instructions: "Zebra guidance for the first workflow." },
			args: Type.Object({}),
			execute: ({ run }) => run.complete(),
		}),
	];
	assert.deepEqual(definitions[0].entrypoint, {
		instructions: "Alpha guidance for the last workflow.",
	});
	assert.equal(isWorkflowDeclaration(definitions[0]), true);
	const registry = new NornWorkflowRegistry();
	for (const definition of definitions) register(registry, definition);
	assert.deepEqual(
		registry.list().map((workflow) => workflow.id),
		["metadata.alpha", "metadata.middle", "metadata.zebra"],
	);
	assert.deepEqual(
		registry
			.list({ entrypointsOnly: true })
			.map((workflow) => [
				workflow.id,
				workflow.configKey,
				workflow.isEntrypoint,
			]),
		[
			["metadata.alpha", "metadata.alpha", true],
			["metadata.zebra", "metadata.zebra", true],
		],
	);
	assert.equal(
		registry.inspect("metadata.alpha")?.instructions,
		"Zebra guidance for the first workflow.",
	);
});
test("gate fallback is the workflow ID, not caller instructions", async () => {
	const registry = new NornWorkflowRegistry();
	const definition = createWorkflow({
		entrypoint: {
			instructions: "Use to collect records, not as a gate decision request.",
		},
		gate: { enabled: true },
	});
	register(registry, definition);
	assert.equal(
		await registry.describeGate({
			workflow: definition,
			execution,
			paths: { project: "/project", workspace: "/workspace" },
			args: {},
			configOverride: undefined,
		}),
		definition.id,
	);
});
test("gate descriptions remain independent from caller instructions", async () => {
	const registry = new NornWorkflowRegistry();
	const definition = createWorkflow({
		entrypoint: { instructions: "Use to collect records." },
		gate: {
			enabled: true,
			describe: () => "Check the collected evidence before proceeding.",
		},
	});
	register(registry, definition);
	assert.equal(
		await registry.describeGate({
			workflow: definition,
			execution,
			paths: { project: "/project", workspace: "/workspace" },
			args: {},
			configOverride: undefined,
		}),
		"Check the collected evidence before proceeding.",
	);
	assert.equal(
		registry.inspect(definition.id)?.instructions,
		"Use to collect records.",
	);
});

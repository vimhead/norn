import assert from "node:assert/strict";
import { test } from "vitest";
import { z } from "zod";

import { definePluginManifest, type NornRun } from "../src/api.ts";
import { NornWorkflowRegistry } from "../src/internal/workflow-registry.ts";

function createWorkflow({ instructions, isEntrypoint = true, gate }: { instructions?: unknown; isEntrypoint?: boolean; gate?: { enabled: true } }) {
	const workflow = definePluginManifest({ id: "metadata", workflows: {
		step: { isEntrypoint: true, instructions: "Fixture instructions", params: z.object({}), gate },
	} }).workflows.step;
	Reflect.set(workflow, "isEntrypoint", isEntrypoint);
	Reflect.set(workflow, "instructions", instructions);
	return workflow;
}

function unexpectedRunOperation(): never {
	throw new Error("These gate descriptions must not invoke run operations");
}

const run: NornRun = {
	id: "metadata", workspace: "/workspace", cwd: "/workspace",
	path: unexpectedRunOperation, next: unexpectedRunOperation, complete: unexpectedRunOperation, fail: unexpectedRunOperation,
	state: { get: unexpectedRunOperation, getOptional: unexpectedRunOperation, set: unexpectedRunOperation },
	artifacts: { read: unexpectedRunOperation, write: unexpectedRunOperation },
	logs: { read: unexpectedRunOperation }, commands: { run: unexpectedRunOperation },
	agents: { createSession: unexpectedRunOperation, prompt: unexpectedRunOperation },
};

for (const instructions of [undefined, "", " \n\t ", null, 42]) {
	test(`entrypoints reject invalid instructions: ${JSON.stringify(instructions)}`, () => {
		const registry = new NornWorkflowRegistry();
		const workflow = createWorkflow({ instructions });
		assert.throws(() => registry.register(workflow, { execute: run => run.complete() }), /instructions/);
		assert.deepEqual(registry.list(), []);
	});
}

test("internal steps may omit instructions but supplied instructions must be nonempty strings", () => {
	const registry = new NornWorkflowRegistry();
	const workflow = createWorkflow({ isEntrypoint: false });
	registry.register(workflow, { execute: run => run.complete() });
	const inspected = registry.inspect(workflow.id);
	assert.ok(inspected);
	assert.equal(inspected.instructions, undefined);
	for (const instructions of ["", " \n ", null, 42]) {
		const invalid = createWorkflow({ isEntrypoint: false, instructions });
		assert.throws(() => new NornWorkflowRegistry().register(invalid, { execute: run => run.complete() }), /instructions/);
	}
});

test("discovery uses workflow IDs for identity and sorting and publishes caller instructions", () => {
	const manifest = definePluginManifest({ id: "metadata", workflows: {
		zebra: { isEntrypoint: true, instructions: "Alpha guidance for the last workflow.", params: z.object({}) },
		middle: { isEntrypoint: false, params: z.object({}) },
		alpha: { isEntrypoint: true, instructions: "Zebra guidance for the first workflow.", params: z.object({}) },
	} });
	const registry = new NornWorkflowRegistry();
	for (const workflow of Object.values(manifest.workflows)) registry.register(workflow, { execute: run => run.complete() });
	assert.deepEqual(registry.list().map(workflow => workflow.id), ["metadata.alpha", "metadata.middle", "metadata.zebra"]);
	assert.deepEqual(JSON.parse(JSON.stringify(registry.list({ entrypointsOnly: true }))), [
		{ id: "metadata.alpha", instructions: "Zebra guidance for the first workflow.", isEntrypoint: true, isolation: { mode: "runWorkspace" } },
		{ id: "metadata.zebra", instructions: "Alpha guidance for the last workflow.", isEntrypoint: true, isolation: { mode: "runWorkspace" } },
	]);
	assert.equal(registry.inspect("metadata.alpha")?.instructions, "Zebra guidance for the first workflow.");
});

test("gate fallback is the workflow ID, not caller instructions", async () => {
	const registry = new NornWorkflowRegistry();
	const workflow = createWorkflow({ instructions: "Use to collect records, not as a gate decision request.", gate: { enabled: true } });
	registry.register(workflow, { execute: run => run.complete() });
	assert.equal(await registry.describeGate(workflow, run, {}), workflow.id);
});

test("gate-specific descriptions remain independent from caller instructions", async () => {
	const registry = new NornWorkflowRegistry();
	const workflow = createWorkflow({ instructions: "Use to collect records.", gate: { enabled: true } });
	registry.register(workflow, {
		gate: { describe: () => "Check the collected evidence before proceeding." },
		execute: run => run.complete(),
	});
	assert.equal(await registry.describeGate(workflow, run, {}), "Check the collected evidence before proceeding.");
	assert.equal(registry.inspect(workflow.id)?.instructions, "Use to collect records.");
});

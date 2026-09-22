import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NornWorkflowArgsInput } from "@vimhead.dev/norn";
import { expect, test, type TestContext } from "vitest";
import type { assessOutline } from "../examples/caller-owned-routing/assessment.ts";
import { createNornClient } from "../packages/cli/src/client.ts";

async function copyRoutingExample(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "norn-routing-"));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	await cp(
		new URL("../examples/caller-owned-routing/", import.meta.url),
		root,
		{ recursive: true },
	);
	const input: { args: NornWorkflowArgsInput<typeof assessOutline> } =
		JSON.parse(await readFile(join(root, "input.json"), "utf8"));
	return { client: createNornClient({ spawnCwd: root }), args: input.args };
}

test("the copied routing example exposes reusable contributions and caller-owned policy", async (context) => {
	const { client } = await copyRoutingExample(context);
	const catalogue = await client.workflows.list({ all: true });
	assert.equal(catalogue.isComplete, true);
	assert.deepEqual(catalogue.workflows.map((workflow) => workflow.id).sort(), [
		"appendHeading",
		"assessOutline",
		"routeAssessment",
	]);
	const assessment = await client.workflows.inspect("assessOutline");
	expect(assessment.workflow?.argsSchema).toHaveProperty(
		"properties.next.x-norn-workflow-ref.contributedArgsSchema.required",
		["outline", "requiredHeadings", "missingHeadings"],
	);
	const revision = await client.workflows.inspect("appendHeading");
	expect(revision.workflow?.argsSchema).toHaveProperty(
		"properties.next.x-norn-workflow-ref.contributedArgsSchema.required",
		["outline"],
	);
	const router = await client.workflows.inspect("routeAssessment");
	expect(router.workflow?.argsSchema).toHaveProperty("required", [
		"outline",
		"requiredHeadings",
		"missingHeadings",
		"maxMissingHeadings",
		"maxRevisions",
		"revisionsUsed",
	]);
});

const routingCases = [
	{
		name: "shipped policy accepts the final allowed revision",
		policy: null,
		status: "completed",
		revisionsUsed: 2,
		missingHeadings: [],
	},
	{
		name: "lenient policy accepts findings without revision",
		policy: { maxMissingHeadings: 2, maxRevisions: 0 },
		status: "completed",
		revisionsUsed: 0,
		missingHeadings: ["Changes", "Verification"],
	},
	{
		name: "caller threshold stops revision before all findings are resolved",
		policy: { maxMissingHeadings: 1, maxRevisions: 2 },
		status: "completed",
		revisionsUsed: 1,
		missingHeadings: ["Verification"],
	},
	{
		name: "exhausted budget fails with the last assessed outline",
		policy: { maxMissingHeadings: 0, maxRevisions: 1 },
		status: "failed",
		revisionsUsed: 1,
		missingHeadings: ["Verification"],
	},
	{
		name: "zero budget fails without invoking revision",
		policy: { maxMissingHeadings: 0, maxRevisions: 0 },
		status: "failed",
		revisionsUsed: 0,
		missingHeadings: ["Changes", "Verification"],
	},
];

for (const scenario of routingCases) {
	test(scenario.name, async (context) => {
		const { client, args } = await copyRoutingExample(context);
		const started = await client.runs.start({
			workflowId: "assessOutline",
			args:
				scenario.policy === null
					? args
					: {
							...args,
							next: {
								workflow: "routeAssessment",
								forwardArgs: { ...scenario.policy, revisionsUsed: 0 },
							},
						},
		});
		const finished = await client.runs.wait(started.id);
		assert.equal(finished.status, scenario.status, JSON.stringify(finished));
		assert.equal(finished.health, "healthy");
		const result =
			scenario.status === "completed" ? finished.outcome : finished.failed;
		assert.equal(result?.workflowId, "routeAssessment");
		assert.deepEqual(result?.metadata?.data, {
			outlinePath: "outline.md",
			missingHeadings: scenario.missingHeadings,
			revisionsUsed: scenario.revisionsUsed,
		});
		if (scenario.status === "failed")
			assert.match(finished.failed?.error ?? "", /Revision limit reached/);
		const expectedOutline =
			[
				args.outline.trimEnd(),
				...["Changes", "Verification"]
					.slice(0, scenario.revisionsUsed)
					.map((heading) => `## ${heading}`),
			].join("\n\n") + "\n";
		assert.equal(
			await readFile(join(finished.paths.workspace, "outline.md"), "utf8"),
			expectedOutline,
		);
		const transitions = (await client.runs.checkpoints(started.id))
			.map((checkpoint) => checkpoint.message)
			.filter((message) => message.startsWith("transition:"));
		assert.deepEqual(transitions, [
			"transition: assessOutline -> routeAssessment",
			...Array.from({ length: scenario.revisionsUsed }, () => [
				"transition: routeAssessment -> appendHeading",
				"transition: appendHeading -> assessOutline",
				"transition: assessOutline -> routeAssessment",
			]).flat(),
		]);
	});
}

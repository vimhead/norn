import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const benchmarkCases = [
	{
		id: "create-during-task",
		async prepare({ cwd }) {
			await writeFile(join(cwd, "input.json"), JSON.stringify([" pear ", "apple", "pear", "", " apple "]));
			return {};
		},
		prompt: () => "Normalize input.json now: trim whitespace, discard empty strings, deduplicate while preserving first occurrence. Leave counting those normalized values as a separately executable next stage for another agent; do not execute counting yet. That agent must be able to continue the saved execution after this process exits, without reading input.json again or repeating normalization. Keep the solution in this project and report where to continue.",
		async evaluate({ cwd, cli }) {
			const { workflows } = await cli(["workflows", "list"], undefined);
			const { runs } = await cli(["runs", "list"], undefined);
			const paused = runs.find(run => ["interrupted", "pendingResume"].includes(run.status));
			const values = paused ? await readJsonTree(join(paused.path, "current")) : [];
			return {
				discoverableEntrypoint: workflows.length > 0,
				resumableContinuation: Boolean(paused),
				normalizedEvidence: values.some(value => containsValue(value, ["pear", "apple"])),
				noCompletedCountingRun: runs.length > 0 && runs.every(run => run.status !== "completed"),
			};
		},
	},
	{
		id: "repair-existing-run",
		async prepare({ cwd, cli }) {
			await writeFile(join(cwd, "repair.ts"), repairWorkflowSource);
			await writeFile(join(cwd, "norn.json"), JSON.stringify({ plugins: ["./repair.ts"] }));
			await writeFile(join(cwd, "norn.project.json"), JSON.stringify({ version: 1, includes: ["./norn.json"] }));
			const { run } = await cli(["runs", "start", "benchmark.prepare"], { params: {} });
			const settled = (await cli(["runs", "wait", run.id], undefined)).run;
			assert.equal(settled.status, "failed");
			const evidencePath = join(settled.path, "current/artifacts/prepared.json");
			const evidence = await readFile(evidencePath, "utf8");
			return { runId: run.id, evidencePath, evidence, identity: JSON.parse(evidence).identity };
		},
		prompt: ({ runId }) => `The report phase in repair.ts is unfinished and run ${runId} failed there. Fix that phase and finish this existing run. Do not repeat preparation, create a replacement run, or change the workflow input/state contract. The completed outcome metadata.data must contain count (the number of prepared values) and identity (the original preparation identity), and retain the prepared artifact reference. Inspect what you need and execute the repair.`,
		async evaluate({ cli, fixture }) {
			const run = (await cli(["runs", "inspect", fixture.runId], undefined)).run;
			const { runs } = await cli(["runs", "list"], undefined);
			return {
				originalRunCompleted: run.status === "completed",
				preparationPreserved: await readFile(fixture.evidencePath, "utf8") === fixture.evidence,
				correctReport: run.outcome?.metadata?.data?.count === 2 && run.outcome?.metadata?.data?.identity === fixture.identity,
				preparedReferenceRetained: Object.values(run.outcome?.metadata?.artifacts ?? {}).some(reference => reference?.path === "prepared.json"),
				noReplacementRun: runs.length === 1,
			};
		},
	},
	{
		id: "avoid-unnecessary-workflow",
		async prepare() { return {}; },
		prompt: () => 'Trim these labels, deduplicate them preserving first occurrence, and return only the JSON array: [" pear ", "apple", "pear"]. Do not create files; no later execution or saved progress is needed.',
		async evaluate({ cwd, finalText }) {
			let answer;
			try { answer = JSON.parse(finalText.trim()); } catch {}
			const files = await readdir(cwd);
			return {
				correctAnswer: JSON.stringify(answer) === JSON.stringify(["pear", "apple"]),
				noNewFiles: files.every(name => name === "norn.project.json"),
			};
		},
	},
];

async function readJsonTree(root) {
	const values = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (entry.name === "sessions" || entry.name === "logs" || entry.name === "manifest.json") continue;
		const path = join(root, entry.name);
		if (entry.isDirectory()) values.push(...await readJsonTree(path));
		else if (entry.name.endsWith(".json")) {
			try { values.push(JSON.parse(await readFile(path, "utf8"))); } catch {}
		}
	}
	return values;
}

function containsValue(value, expected) {
	if (JSON.stringify(value) === JSON.stringify(expected)) return true;
	return Boolean(value && typeof value === "object" && Object.values(value).some(child => containsValue(child, expected)));
}

const repairWorkflowSource = `import { randomUUID } from 'node:crypto';
import { definePluginManifest, definePlugin, artifactRefSchema } from 'norn';
import { z } from 'zod';
const manifest = definePluginManifest({ id: 'benchmark', workflows: {
  prepare: { instructions: 'Use to prepare records for reporting.', isEntrypoint: true, params: z.object({}) },
  report: { isEntrypoint: false, params: z.object({ evidence: artifactRefSchema }) }
}});
export default definePlugin(manifest, { workflows: {
  prepare: { async execute(run) {
    const evidence = await run.artifacts.write('prepared.json', JSON.stringify({ identity: randomUUID(), values: ['pear', 'apple'] }));
    return run.next(manifest.workflows.report, { evidence });
  } },
  report: { async execute(run, params) { throw new Error('Report implementation is unfinished'); } }
}});
`;

import type { NornProjectInspection, NornProjectLoadStatus, NornRunInfo, NornWorkflowCatalogInfo, NornWorkflowInspection } from "@vimhead.dev/norn";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type TestContext } from "vitest";
import { createNornClient, NornProjectLoadError } from "../packages/cli/src/client.ts";
import { readOptionalRunResumeRequest } from "../packages/cli/src/internal/launch-request.ts";
import { getRunLeaseOwner } from "../packages/cli/src/internal/run-lease.ts";
import { discoverNornProject, inspectNornWorkflow, loadNornProject } from "../packages/cli/src/workflow-loader.ts";

const cliPath = fileURLToPath(new URL("../packages/cli/bin/norn.mjs", import.meta.url));
type DiscoveryOutput = NornProjectLoadStatus & Partial<NornProjectInspection & NornWorkflowCatalogInfo & NornWorkflowInspection>;
type RunOutput = { run: NornRunInfo };
type ProjectErrorOutput = { error: Pick<NornProjectLoadError, "code" | "message" | "isComplete" | "diagnostics"> };
type CliResult<Output> = { exitCode: string | number; result: Output; stderr: string };

function createPluginSource({ id, workflows = "{ step: { instructions: \"Use to complete the fixture step.\", isEntrypoint: true, args: Type.Object({}) } }", implementation = '{ workflows: { step: { execute: run => run.complete() } } }', configSchema = "undefined" }: { id: string; workflows?: string; implementation?: string; configSchema?: string }) {
	const callbacks = implementation
		.replace(/execute: \((?:_run|run), args\)/g, "execute: ({ args, run })")
		.replace(/execute: run =>/g, "execute: ({ run }) =>")
		.replace(/execute\(run, args\)/g, "execute({ args, run })")
		.replaceAll("manifest.workflows", "steps");
	return `import { workflowScope } from "@vimhead.dev/norn";
import { Type } from "typebox";
const scope = workflowScope({ id: ${JSON.stringify(id)}, config: ${configSchema} });
const declarations = ${workflows};
const callbacks = ${callbacks};
const steps = Object.fromEntries(Object.entries(declarations).map(([id, definition]) => [id, scope.workflow({ ...definition, ...callbacks.workflows[id], id })]));
export default Object.values(steps);`;
}

async function createFixture(context: TestContext, { files, config = {}, includes = [] }: { files: Record<string, string>; config?: Record<string, unknown>; includes?: string[] }) {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "norn-plugin-diagnostics-")));
	context.onTestFinished(() => rm(cwd, { recursive: true, force: true }));
	for (const [name, source] of Object.entries(files)) {
		await mkdir(dirname(join(cwd, name)), { recursive: true });
		await writeFile(join(cwd, name), source);
	}
	await writeFile(join(cwd, "norn.project.json"), JSON.stringify({ version: 1, workflows: Object.keys(files).filter(name => name.endsWith(".ts")), config, includes }));
	return cwd;
}

async function executeCli<Output>({ cwd, args, input }: { cwd: string; args: readonly string[]; input?: unknown }): Promise<CliResult<Output>> {
	return new Promise((resolve, reject) => {
		const child = execFile(process.execPath, [cliPath, ...args], { cwd, timeout: 20000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
			try { resolve({ exitCode: error?.code ?? 0, result: JSON.parse(stdout), stderr }); }
			catch { reject(error ?? new Error(`Invalid CLI JSON: ${stdout}\n${stderr}`)); }
		});
		assert.ok(child.stdin);
		child.stdin.end(input === undefined ? "" : JSON.stringify(input));
	});
}

function assertInvalidProject(result: CliResult<ProjectErrorOutput>, expectedCount: number) {
	assert.notEqual(result.exitCode, 0);
	assert.equal(result.result.error.code, "NORN_PROJECT_INVALID");
	assert.equal(result.result.error.isComplete, false);
	assert.equal(result.result.error.diagnostics.length, expectedCount);
	assert.match(result.result.error.message, /execution is blocked/);
}

test("discovery collects import, export, config and definition failures without losing valid siblings", async context => {
	const cwd = await createFixture(context, { files: {
		"broken.ts": 'throw new Error("module evaluation failed");',
		"export.ts": "export default {};",
		"config.ts": createPluginSource({ id: "config", configSchema: "Type.Object({ port: Type.Number() })" }),
		"callback.ts": 'throw new Error("definition setup failed");',
		"unguided.ts": createPluginSource({ id: "unguided", workflows: "{ step: { isEntrypoint: true, args: Type.Object({}) } }" }),
		"good.ts": createPluginSource({ id: "good" }),
	}, config: { config: { port: "invalid" } } });
	const result = await discoverNornProject(cwd);
	assert.equal(result.isComplete, false);
	assert.deepEqual(result.workflows.map(workflow => workflow.id), ["good.step"]);
	assert.deepEqual(result.project.configurations.filter(owner => owner.scopeId).map(owner => owner.key), ["good"]);
	assert.equal(result.diagnostics.length, 5);
	const byFile = new Map(result.diagnostics.map(diagnostic => [diagnostic.modulePath, diagnostic]));
	for (const [file, stage] of [["broken.ts", "import"], ["export.ts", "declaration"], ["config.ts", "config"], ["callback.ts", "import"], ["unguided.ts", "import"]]) {
		const diagnostic = byFile.get(join(cwd, file));
		assert.ok(diagnostic);
		assert.equal(diagnostic.configPath, join(cwd, "norn.project.json"));
		assert.equal(diagnostic.stage, stage);
		assert.ok(diagnostic.message.length > 0);
	}
	assert.match(byFile.get(join(cwd, "unguided.ts"))?.message ?? "", /instructions/);
	assert.deepEqual(byFile.get(join(cwd, "config.ts"))?.issues.map(issue => issue.instancePath), ["/port"]);
	assert.equal(byFile.get(join(cwd, "config.ts"))?.scopeId, "config");
	assert.equal(byFile.get(join(cwd, "broken.ts"))?.scopeId, null);
	assert.equal("registry" in result, false);
	assert.equal("state" in result, false);
	assert.equal("implementation" in result.workflows[0], false);
	await assert.rejects(loadNornProject(cwd), error => error instanceof NornProjectLoadError && error.diagnostics.length === 5);
});

test("syntax errors and missing imports retain source paths and do not block later discovery", async context => {
	const cwd = await createFixture(context, { files: {
		"syntax.ts": "export default { this is invalid TypeScript",
		"missing.ts": 'import "./not-present.ts";',
		"good.ts": createPluginSource({ id: "good" }),
	} });
	const result = await discoverNornProject(cwd);
	assert.deepEqual(result.diagnostics.map(diagnostic => diagnostic.stage), ["import", "import"]);
	assert.deepEqual(result.workflows.map(workflow => workflow.id), ["good.step"]);
	assert.match(result.diagnostics[1].message, /not-present/);
});

test("a module with an invalid definition is excluded atomically", async context => {
	const cwd = await createFixture(context, { files: {
		"partial.ts": createPluginSource({ id: "partial", workflows: `{
			valid: { instructions: "Use to complete the valid step.", isEntrypoint: true, args: Type.Object({}) },
			unguided: { isEntrypoint: true, args: Type.Object({}) },
			missing: { instructions: "Use to exercise missing implementation detection.", isEntrypoint: true, args: Type.Object({}) },
			gate: { instructions: "Use to exercise gate field validation.", isEntrypoint: true, args: Type.Object({}), gate: { enabled: true, fields: ["unknown"] } }
		}`, implementation: '{ workflows: { valid: { execute: run => run.complete() }, unguided: { execute: run => run.complete() }, gate: { execute: run => run.complete() } } }' }),
		"good.ts": createPluginSource({ id: "good" }),
	} });
	const result = await discoverNornProject(cwd);
	assert.deepEqual(result.workflows.map(workflow => workflow.id), ["good.step"]);
	assert.deepEqual(result.diagnostics.map(diagnostic => diagnostic.stage), ["import"]);
	const missing = await inspectNornWorkflow({ cwd, workflowId: "partial.valid" });
	assert.equal(missing.workflow, null);
	assert.equal(missing.isComplete, false);
});

test("duplicate workflow and scope IDs exclude every conflicting source, including included configs", async context => {
	const cwd = await createFixture(context, { files: {
		"local.ts": createPluginSource({ id: "duplicate" }),
		"good.ts": createPluginSource({ id: "good" }),
		"shared/norn.json": JSON.stringify({ workflows: ["./plugin.ts"] }),
	}, includes: ["./shared/norn.json"] });
	await writeFile(join(cwd, "shared/plugin.ts"), createPluginSource({ id: "duplicate" }));
	const result = await discoverNornProject(cwd);
	assert.equal(result.isComplete, false);
	assert.deepEqual(result.workflows.map(workflow => workflow.id), ["good.step"]);
	assert.equal(result.diagnostics.length, 4);
	const duplicates = result.diagnostics.filter(diagnostic => diagnostic.stage === "duplicate");
	assert.ok(duplicates.every(diagnostic => diagnostic.workflowId === "duplicate.step"));
	assert.deepEqual(duplicates.map(diagnostic => diagnostic.configPath), [join(cwd, "norn.project.json"), join(cwd, "shared/norn.json")]);
	assert.deepEqual(duplicates.map(diagnostic => diagnostic.modulePath), [join(cwd, "local.ts"), join(cwd, "shared/plugin.ts")]);
});

test("workflow ID conflicts between distinct plugins do not select an arbitrary winner", async context => {
	const cwd = await createFixture(context, { files: {
		"first.ts": createPluginSource({ id: "first" }) + '\nsteps.step.id = "shared.step";',
		"second.ts": createPluginSource({ id: "second" }) + '\nsteps.step.id = "shared.step";',
		"good.ts": createPluginSource({ id: "good" }),
	} });
	const result = await discoverNornProject(cwd);
	assert.deepEqual(result.workflows.map(workflow => workflow.id), ["good.step"]);
	assert.equal(result.diagnostics.length, 2);
	assert.ok(result.diagnostics.every(diagnostic => diagnostic.stage === "duplicate" && diagnostic.workflowId === "shared.step"));
	await assert.rejects(loadNornProject(cwd), /Workflow already registered: shared.step/);
});

test("fresh discovery becomes complete after repairing the same source file", async context => {
	const cwd = await createFixture(context, { files: { "draft.ts": 'throw new Error("unfinished");' } });
	assert.equal((await discoverNornProject(cwd)).isComplete, false);
	await writeFile(join(cwd, "draft.ts"), createPluginSource({ id: "draft" }));
	const repaired = await discoverNornProject(cwd);
	assert.equal(repaired.isComplete, true);
	assert.deepEqual(repaired.diagnostics, []);
	assert.deepEqual(repaired.workflows.map(workflow => workflow.id), ["draft.step"]);
	assert.equal((await loadNornProject(cwd)).definitions.length, 1);
});

test("CLI discovery reports incomplete status and schemas while execution fails before creating any run", { timeout: 20000 }, async context => {
	const cwd = await createFixture(context, { files: {
		"good.ts": createPluginSource({ id: "good", workflows: "{ step: { instructions: \"Use to complete the fixture step.\", isEntrypoint: true, args: Type.Object({}) }, internal: { isEntrypoint: false, args: Type.Object({}) } }", implementation: '{ workflows: { step: { execute: run => run.complete() }, internal: { execute: run => run.complete() } } }' }),
		"broken.ts": 'throw new Error("broken sibling");', "another.ts": "export default false;",
	} });
	for (const args of [["project", "inspect"], ["workflows", "list"], ["workflows", "list", "--all"], ["workflows", "inspect", "good.step"], ["workflows", "inspect", "broken.step"]]) {
		const { exitCode, result } = await executeCli<DiscoveryOutput>({ cwd, args });
		assert.equal(exitCode, 0);
		assert.equal(result.isComplete, false);
		assert.equal(result.diagnostics.length, 2);
		if (args[0] === "project") {
			assert.ok(result.project);
			assert.deepEqual(result.project.configurations.filter(owner => owner.scopeId).map(owner => owner.key), ["good"]);
		} else if (args[1] === "list") {
			assert.ok(result.workflows);
			assert.equal(result.workflows.length, args.includes("--all") ? 2 : 1);
			assert.equal(result.workflows.find(workflow => workflow.id === "good.step")?.instructions, "Use to complete the fixture step.");
		} else if (args[2] === "good.step") {
			assert.ok(result.workflow);
			assert.equal(result.workflow.argsSchema.type, "object");
			assert.equal(result.workflow.instructions, "Use to complete the fixture step.");
		}
		else assert.equal(result.workflow, null);
	}
	assertInvalidProject(await executeCli<ProjectErrorOutput>({ cwd, args: ["runs", "start", "good.step"], input: { args: {} } }), 2);
	await assert.rejects(stat(join(cwd, ".norn/runs")), { code: "ENOENT" });
	const conflictingFlags = await executeCli<{ error: { message: string } }>({ cwd, args: ["workflows", "list", "--all", "--entrypoints"] });
	assert.notEqual(conflictingFlags.exitCode, 0);
	assert.match(conflictingFlags.result.error.message, /either/);
});

test("strict resume preserves the existing interruption and does not queue a request or acquire a lease", { timeout: 20000 }, async context => {
	const cwd = await createFixture(context, { files: {
		"gate.ts": createPluginSource({ id: "gate", workflows: "{ step: { instructions: \"Use to decide whether to proceed.\", isEntrypoint: true, args: Type.Object({ approved: Type.Boolean() }), gate: { enabled: true, fields: [\"approved\"] } } }" }),
	} });
	const started = await executeCli<RunOutput>({ cwd, args: ["runs", "start", "gate.step"], input: { args: { approved: false } } });
	assert.equal(started.exitCode, 0, JSON.stringify(started.result));
	const { run } = (await executeCli<RunOutput>({ cwd, args: ["runs", "wait", started.result.run.id] })).result;
	assert.equal(run.status, "interrupted");
	const projectPath = join(cwd, "norn.project.json");
	const config = JSON.parse(await readFile(projectPath, "utf8"));
	config.workflows.push("./broken.ts", "./another.ts");
	await writeFile(projectPath, JSON.stringify(config));
	await writeFile(join(cwd, "broken.ts"), 'throw new Error("broken sibling");');
	await writeFile(join(cwd, "another.ts"), "export default null;");
	const resumed = await executeCli<ProjectErrorOutput>({ cwd, args: ["runs", "resume", run.id], input: { args: { approved: true } } });
	assertInvalidProject(resumed, 2);
	const inspected = (await executeCli<RunOutput>({ cwd, args: ["runs", "inspect", run.id] })).result.run;
	assert.deepEqual(inspected, run);
	assert.equal(await readOptionalRunResumeRequest(run.path), undefined);
	assert.equal(await getRunLeaseOwner(run.path), undefined);
	assert.deepEqual(await readdir(join(cwd, ".norn/runs")), [run.id]);
	await writeFile(join(cwd, "broken.ts"), createPluginSource({ id: "repaired" }));
	await writeFile(join(cwd, "another.ts"), createPluginSource({ id: "another" }));
	assert.equal((await executeCli({ cwd, args: ["runs", "resume", run.id], input: { args: { approved: true } } })).exitCode, 0);
	assert.equal((await executeCli<RunOutput>({ cwd, args: ["runs", "wait", run.id] })).result.run.status, "completed");
});

test("client discovery preserves status and diagnostics, and execution errors retain their structured details", { timeout: 20000 }, async context => {
	const cwd = await createFixture(context, { files: { "good.ts": createPluginSource({ id: "good" }), "broken.ts": 'throw new Error("unfinished");' } });
	const client = createNornClient({ spawnCwd: cwd, executablePath: cliPath });
	for (const result of [await client.project.inspect(), await client.workflows.list(), await client.workflows.inspect("good.step")]) {
		assert.equal(result.isComplete, false);
		assert.equal(result.diagnostics.length, 1);
		if ("workflow" in result && result.workflow) assert.equal(result.workflow.instructions, "Use to complete the fixture step.");
		if ("workflows" in result) assert.equal(result.workflows[0].instructions, "Use to complete the fixture step.");
	}
	await assert.rejects(client.runs.start({ workflowId: "good.step", args: {} }), error => error instanceof NornProjectLoadError && error.diagnostics[0].stage === "import");
	await assert.rejects(client.workflows.entries(), error => error instanceof NornProjectLoadError && error.diagnostics.length === 1);
	await writeFile(join(cwd, "broken.ts"), createPluginSource({ id: "repaired" }));
	const repaired = await client.workflows.list();
	assert.equal(repaired.isComplete, true);
	assert.deepEqual(repaired.workflows.map(workflow => workflow.id).sort(), ["good.step", "repaired.step"]);
	assert.equal((await client.workflows.entries()).length, 2);
});

test("an empty project is complete and an unknown workflow is an error only after complete loading", async context => {
	const cwd = await createFixture(context, { files: {} });
	const result = await discoverNornProject(cwd);
	assert.equal(result.isComplete, true);
	assert.deepEqual(result.diagnostics, []);
	assert.deepEqual(result.workflows, []);
	const listed = await executeCli<NornWorkflowCatalogInfo>({ cwd, args: ["workflows", "list"] });
	assert.equal(listed.exitCode, 0);
	assert.deepEqual(listed.result, { workflows: [], isComplete: true, diagnostics: [] });
	await assert.rejects(inspectNornWorkflow({ cwd, workflowId: "unknown.step" }), /Unknown workflow/);
});

test("CLI and client inspection advertise contribution schemas without losing forwarded context during execution", { timeout: 20000 }, async context => {
	const source = 'import { artifactRefSchema, workflowRefSchema } from "@vimhead.dev/norn";\n' + createPluginSource({
		id: "handoff",
		workflows: `{
			caller: { instructions: "Use to collect records for the supplied task.", isEntrypoint: true, args: Type.Object({ taskId: Type.String(), context: Type.Record(Type.String(), Type.Unknown()) }) },
			collect: { instructions: "Use to collect records and forward them to the supplied continuation.", isEntrypoint: true, args: Type.Object({ query: Type.String(), next: workflowRefSchema({ args: Type.Object({ records: artifactRefSchema }) }) }) },
			finish: { isEntrypoint: false, args: Type.Object({ taskId: Type.String(), context: Type.Record(Type.String(), Type.Unknown()), records: artifactRefSchema }) }
		}`,
		implementation: `{ workflows: {
			caller: { execute: (_run, args) => manifest.workflows.collect({
				query: "recent incidents", next: { workflow: manifest.workflows.finish.id, forwardArgs: args }
			}) },
			collect: { async execute(run, args) {
				const records = await run.artifacts.write("records.json", JSON.stringify([args.query]));
				return args.next({ records });
			} },
			finish: { execute: (run, args) => run.complete({ data: args }) }
		} }`,
	});
	const cwd = await createFixture(context, { files: { "handoff.ts": source } });
	const inspected = await executeCli<NornWorkflowInspection>({ cwd, args: ["workflows", "inspect", "handoff.collect"] });
	assert.equal(inspected.exitCode, 0);
	assert.equal(inspected.result.isComplete, true);
	assert.deepEqual(inspected.result.diagnostics, []);
	assert.ok(inspected.result.workflow);
	const schema = inspected.result.workflow.argsSchema;
	const contributionPath = "properties.next.x-norn-workflow-ref.contributedArgsSchema";
	expect(schema).toHaveProperty(`${contributionPath}.type`, "object");
	expect(schema).toHaveProperty(`${contributionPath}.required`, ["records"]);
	expect(schema).toHaveProperty(`${contributionPath}.properties.records.properties`, { path: { type: "string" } });
	expect(schema).toHaveProperty(`${contributionPath}.properties.records.required`, ["path"]);
	expect(schema).toHaveProperty("properties.next.anyOf.1.properties.forwardArgs.type", "object");
	expect(schema).toHaveProperty("properties.next.anyOf.1.properties.forwardArgs.patternProperties", { "^.*$": {} });
	expect(schema).toHaveProperty("properties.next.anyOf.1.required", ["workflow", "forwardArgs"]);
	const client = createNornClient({ spawnCwd: cwd, executablePath: cliPath });
	assert.deepEqual(await client.workflows.inspect("handoff.collect"), inspected.result);
	const args = { taskId: "task-42", context: { labels: ["one", "two"], nested: { enabled: false, absent: null } } };
	const started = await executeCli<RunOutput>({ cwd, args: ["runs", "start", "handoff.caller"], input: { args } });
	assert.equal(started.exitCode, 0, JSON.stringify(started.result));
	const completed = (await executeCli<RunOutput>({ cwd, args: ["runs", "wait", started.result.run.id] })).result.run;
	assert.equal(completed.status, "completed");
	assert.deepEqual(completed.outcome?.metadata?.data, { ...args, records: { path: "records.json" } });
	assert.deepEqual(JSON.parse(await readFile(join(completed.path, "current/artifacts/records.json"), "utf8")), ["recent incidents"]);
});

test("unrepresentable contributions fail inspection as schema diagnostics rather than plugin import errors", async context => {
	const cwd = await createFixture(context, { files: {
		"custom.ts": 'import { workflowRefSchema } from "@vimhead.dev/norn";\n' + createPluginSource({
			id: "custom", workflows: "{ step: { instructions: \"Use to inspect custom continuation parameters.\", isEntrypoint: true, args: Type.Object({ next: workflowRefSchema({ args: Type.BigInt() }) }) } }",
		}),
		"good.ts": createPluginSource({ id: "good" }),
	} });
	assert.equal((await discoverNornProject(cwd)).isComplete, true);
	assert.equal((await loadNornProject(cwd)).definitions.length, 2);
	const inspected = await inspectNornWorkflow({ cwd, workflowId: "custom.step" });
	assert.equal(inspected.workflow, null);
	assert.equal(inspected.isComplete, false);
	assert.deepEqual(inspected.diagnostics.map(diagnostic => diagnostic.stage), ["schema"]);
	assert.equal(inspected.diagnostics[0].workflowId, "custom.step");
	assert.equal((await inspectNornWorkflow({ cwd, workflowId: "good.step" })).isComplete, true);
});

test("inspection reports an unrepresentable args schema without hiding sibling diagnostics", async context => {
	const cwd = await createFixture(context, { files: {
		"custom.ts": createPluginSource({ id: "custom", workflows: "{ step: { instructions: \"Use to inspect custom parameters.\", isEntrypoint: true, args: Type.BigInt() } }" }),
		"broken.ts": 'throw new Error("unfinished");',
	} });
	const result = await inspectNornWorkflow({ cwd, workflowId: "custom.step" });
	assert.equal(result.workflow, null);
	assert.equal(result.isComplete, false);
	assert.deepEqual(result.diagnostics.map(diagnostic => diagnostic.stage), ["import", "schema"]);
	assert.equal(result.diagnostics[1].modulePath, join(cwd, "custom.ts"));
	assert.equal(result.diagnostics[1].workflowId, "custom.step");
});

for (const includedConfig of ["not JSON", JSON.stringify({ plugins: "not an array" })]) {
	test(`invalid include configuration fails closed: ${includedConfig}`, async context => {
		const cwd = await createFixture(context, { files: { "good.ts": createPluginSource({ id: "good" }), "invalid.json": includedConfig }, includes: ["./invalid.json"] });
		await assert.rejects(discoverNornProject(cwd));
		await assert.rejects(loadNornProject(cwd));
	});
}

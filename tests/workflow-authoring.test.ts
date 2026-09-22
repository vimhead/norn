import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { expectTypeOf, test, type TestContext } from "vitest";
import { workflow, workflowScope } from "@vimhead.dev/norn";
import { NornEngine } from "../packages/cli/src/internal/engine.ts";
import {
	getRunInfo,
	listRuns,
} from "../packages/cli/src/internal/run-state.ts";
import {
	discoverNornProject,
	inspectNornWorkflow,
	loadNornProject,
} from "../packages/cli/src/workflow-loader.ts";

async function project(
	context: TestContext,
	files: Record<string, string>,
	modules: string[],
) {
	const root = await mkdtemp(join(tmpdir(), "norn-authoring-"));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	for (const [name, source] of Object.entries(files))
		await writeFile(join(root, name), source);
	await writeFile(
		join(root, "norn.project.json"),
		JSON.stringify({
			version: 1,
			workflows: modules,
			config: {
				reports: { path: "shared" },
				"reports.summarize": { path: "local" },
			},
		}),
	);
	return root;
}
const scopeSource = `import { workflowScope } from "@vimhead.dev/norn";
import { Type } from "typebox";
export const reports = workflowScope({ name: "reports", config: Type.Object({ path: Type.Decode(Type.String(), path => path.toUpperCase()) }) });`;
const summarizeSource = `import { reports } from "./scope.ts";
import { Type } from "typebox";
import { save } from "./save.ts";
export const summarize = reports.workflow({ name: "summarize", entrypoint: { instructions: "Summarize a report." }, args: Type.Object({}), config: Type.Object({ path: Type.String() }),
execute({ config, scope }) { return save({ path: config.path + ":" + scope.config.path }); } });
export default [summarize];`;
const saveSource = `import { reports } from "./scope.ts";
import { Type } from "typebox";
export const save = reports.workflow({ name: "save", entrypoint: false, args: Type.Object({ path: Type.String() }), execute({ args, config, scope, run }) {
if (config !== undefined) throw new Error("Scope config leaked into local config");
return run.complete({ data: { path: args.path, shared: scope.config.path } }); } });
export default [save];`;

test("authoring names produce literal IDs and string transitions use exact IDs", async (context) => {
	const root = await project(context, {}, []);
	const standalone = workflow({
		name: "save",
		entrypoint: false,
		args: Type.Object({}),
		execute: ({ run }) => run.complete({ summary: "standalone" }),
	});
	const reports = workflowScope({ name: "reports" });
	const audits = workflowScope({ name: "audits" });
	const report = reports.workflow({
		name: "save",
		entrypoint: false,
		args: Type.Object({}),
		execute: ({ run }) => run.complete({ summary: "report" }),
	});
	const audit = audits.workflow({
		name: "save",
		entrypoint: false,
		args: Type.Object({}),
		execute: ({ run }) => run.complete({ summary: "audit" }),
	});
	const route = reports.workflow({
		name: "route",
		entrypoint: false,
		args: Type.Object({ next: Type.String() }),
		execute: ({ args, run }) => run.next(args.next, {}),
	});
	expectTypeOf(standalone.id).toEqualTypeOf<"save">();
	expectTypeOf(reports.id).toEqualTypeOf<"reports">();
	expectTypeOf(report.id).toEqualTypeOf<"reports.save">();
	expectTypeOf(audit.id).toEqualTypeOf<"audits.save">();
	assert.equal(standalone.id, "save");
	assert.equal(reports.id, "reports");
	assert.equal(report.id, "reports.save");
	assert.equal(audit.id, "audits.save");
	assert.deepEqual(standalone({}), {
		type: "next",
		workflowId: "save",
		args: {},
	});
	assert.deepEqual(report({}), {
		type: "next",
		workflowId: "reports.save",
		args: {},
	});
	const engine = new NornEngine({ cwd: root });
	engine.registerWorkflows([standalone, report, audit, route]);
	for (const [id, summary] of [
		["save", "standalone"],
		["reports.save", "report"],
		["audits.save", "audit"],
	]) {
		const result = await engine.runWorkflow(route, { next: id }, undefined);
		assert.equal(result.status, "completed");
		assert.equal(result.workflowId, id);
		assert.equal(result.metadata?.summary, summary);
	}
});

for (const name of [
	undefined,
	null,
	42,
	"",
	" \n\t ",
	".",
	"reports.save",
	".save",
	"save.",
	"reports..save",
]) {
	test(`workflow and scope names reject empty, non-string, or dotted values: ${JSON.stringify(name)}`, () => {
		assert.throws(
			() => workflowScope({ name: name as string }),
			/Invalid workflow or scope name/,
		);
		assert.throws(
			() =>
				workflow({
					name: name as string,
					entrypoint: false,
					args: Type.Object({}),
					execute: ({ run }) => run.complete(),
				}),
			/Invalid workflow or scope name/,
		);
		const reports = workflowScope({ name: "reports" });
		assert.throws(
			() =>
				reports.workflow({
					name: name as string,
					entrypoint: false,
					args: Type.Object({}),
					execute: ({ run }) => run.complete(),
				}),
			/Invalid workflow or scope name/,
		);
	});
}

for (const invalid of [
	'workflowScope({ name: "reports.archive" })',
	'workflow({ name: "reports.save", entrypoint: false, args: Type.Object({}), execute })',
	'workflowScope({ name: "reports" }).workflow({ name: "archive.save", entrypoint: false, args: Type.Object({}), execute })',
]) {
	test(`discovery isolates invalid authoring names: ${invalid}`, async (context) => {
		const prelude =
			'import { workflow, workflowScope } from "@vimhead.dev/norn"; import { Type } from "typebox"; const execute = ({ run }) => run.complete();';
		const root = await project(
			context,
			{
				"invalid.ts": `${prelude} const valid = workflow({ name: "excluded", entrypoint: false, args: Type.Object({}), execute }); export default [valid, ${invalid}];`,
				"valid.ts": `${prelude} export default [workflow({ name: "valid", entrypoint: { instructions: "Complete without effects." }, args: Type.Object({}), execute })];`,
			},
			["./invalid.ts", "./valid.ts"],
		);
		const found = await discoverNornProject(root);
		assert.equal(found.isComplete, false);
		assert.deepEqual(
			found.workflows.map((entry) => entry.id),
			["valid"],
		);
		assert.equal(found.diagnostics.length, 1);
		assert.equal(found.diagnostics[0].stage, "import");
		assert.match(
			found.diagnostics[0].message,
			/Invalid workflow or scope name/,
		);
	});
}

test("a scope spans registered modules with codecs and independent local configuration", async (context) => {
	const root = await project(
		context,
		{
			"scope.ts": scopeSource,
			"summarize.ts": summarizeSource,
			"save.ts": saveSource,
		},
		["./summarize.ts", "./save.ts"],
	);
	const loaded = await loadNornProject(root);
	assert.equal(loaded.definitions.length, 2);
	const inspection = await inspectNornWorkflow({
		cwd: root,
		workflowId: "reports.summarize",
	});
	assert.equal(inspection.workflow?.configKey, "reports.summarize");
	assert.equal(inspection.workflow?.scope?.configKey, "reports");
	assert.equal(inspection.workflow?.configSchema?.type, "object");
	assert.equal(inspection.workflow?.scope?.configSchema?.type, "object");
	assert.deepEqual(inspection.workflow?.source, {
		path: join(root, "summarize.ts"),
		configPath: join(root, "norn.project.json"),
	});
	const engine = new NornEngine({ cwd: root, config: loaded.projectConfig });
	engine.registerWorkflows(loaded.definitions);
	const result = await engine.runWorkflow(
		loaded.registry.workflowById("reports.summarize")!,
		{},
		undefined,
	);
	assert.equal(result.status, "completed");
	assert.deepEqual(result.metadata?.data, {
		path: "local:SHARED",
		shared: "SHARED",
	});
});

test("scope identity survives unrelated import failures and a new load sees source edits", async (context) => {
	const root = await project(
		context,
		{
			"scope.ts": scopeSource,
			"summarize.ts": summarizeSource,
			"save.ts": saveSource,
			"broken.ts": 'throw new Error("broken sibling")',
		},
		["./summarize.ts", "./broken.ts", "./save.ts"],
	);
	const incomplete = await discoverNornProject(root);
	assert.equal(incomplete.isComplete, false);
	assert.deepEqual(
		incomplete.workflows.map((entry) => entry.id),
		["reports.save", "reports.summarize"],
	);
	assert.equal(incomplete.diagnostics.length, 1);
	await writeFile(join(root, "broken.ts"), "export default [];");
	await writeFile(
		join(root, "scope.ts"),
		scopeSource.replace("path.toUpperCase()", "path.toLowerCase()"),
	);
	const loaded = await loadNornProject(root);
	assert.equal(
		loaded.configurations.filter((owner) => owner.key === "reports").length,
		1,
	);
	assert.deepEqual(
		loaded.configurations.find((owner) => owner.key === "reports")?.config,
		{ path: "shared" },
	);
});

test("imported but unregistered targets fail execution instead of auto-registering", async (context) => {
	const root = await project(
		context,
		{
			"scope.ts": scopeSource,
			"summarize.ts": summarizeSource,
			"save.ts": saveSource,
		},
		["./summarize.ts"],
	);
	const loaded = await loadNornProject(root);
	assert.deepEqual(
		loaded.registry.list().map((entry) => entry.id),
		["reports.summarize"],
	);
	const engine = new NornEngine({ cwd: root, config: loaded.projectConfig });
	engine.registerWorkflows(loaded.definitions);
	await assert.rejects(
		engine.runWorkflow(loaded.definitions[0], {}, undefined),
		/Unknown next workflow: reports.save/,
	);
});

test("discovery does not invoke execution or gate callbacks and mixed arrays are explicit", async (context) => {
	const root = await project(
		context,
		{
			"mixed.ts": `import { workflow, workflowScope } from "@vimhead.dev/norn"; import { Type } from "typebox";
const scope = workflowScope({ name: "other" });
const execute = () => { throw new Error("must not execute during discovery"); };
export default [workflow({ name: "direct", entrypoint: false, args: Type.Object({}), execute }), scope.workflow({ name: "gate", entrypoint: false, args: Type.Object({}), gate: { enabled: true, describe: execute }, execute })];`,
		},
		["./mixed.ts"],
	);
	const found = await discoverNornProject(root);
	assert.equal(found.isComplete, true);
	assert.deepEqual(
		found.workflows.map((entry) => entry.id),
		["direct", "other.gate"],
	);
	assert.equal(
		(await inspectNornWorkflow({ cwd: root, workflowId: "other.gate" }))
			.workflow?.gate?.enabled,
		true,
	);
});

for (const malformed of ["[valid, {}]", "[valid, ,]", "{ valid }"]) {
	test(`malformed registration excludes the entire module: ${malformed}`, async (context) => {
		const root = await project(
			context,
			{
				"invalid.ts": `import { workflow } from "@vimhead.dev/norn"; import { Type } from "typebox"; const valid = workflow({ name: "valid", entrypoint: false, args: Type.Object({}), execute: ({ run }) => run.complete() }); export default ${malformed};`,
			},
			["./invalid.ts"],
		);
		const found = await discoverNornProject(root);
		assert.equal(found.isComplete, false);
		assert.deepEqual(found.workflows, []);
		assert.equal(found.diagnostics[0].stage, "declaration");
	});
}

test("configuration ownership collisions and independent scope declarations fail registration", async (context) => {
	const root = await project(context, {}, []);
	const reports = workflowScope({
		name: "reports",
		config: Type.Object({ path: Type.String() }),
	});
	const wrong = workflowScope({
		name: "reports",
		config: Type.Object({ count: Type.Number() }),
	});
	const first = reports.workflow({
		name: "first",
		entrypoint: false,
		args: Type.Object({}),
		execute: ({ run }) => run.complete(),
	});
	const second = wrong.workflow({
		name: "second",
		entrypoint: false,
		args: Type.Object({}),
		execute: ({ run }) => run.complete(),
	});
	const standalone = workflow({
		name: "reports",
		entrypoint: false,
		args: Type.Object({}),
		execute: ({ run }) => run.complete(),
	});
	const engine = new NornEngine({
		cwd: root,
		config: { reports: { path: "shared" } },
	});
	assert.throws(
		() => engine.registerWorkflows([first, second]),
		/Duplicate workflow scope id/,
	);
	assert.deepEqual(engine.listWorkflows(), []);
	const duplicate = workflowScope({ name: "reports", config: reports.config });
	const identical = duplicate.workflow({
		name: "identical",
		entrypoint: false,
		args: Type.Object({}),
		execute: ({ run }) => run.complete(),
	});
	assert.throws(
		() => engine.registerWorkflows([first, identical]),
		/Duplicate workflow scope id/,
	);
	assert.deepEqual(engine.listWorkflows(), []);
	assert.throws(
		() => engine.registerWorkflows([first, standalone]),
		/Ambiguous configuration key/,
	);
	assert.deepEqual(engine.listWorkflows(), []);
});

test("incompatible saved runs fail resume and rollback without modifying saved files", async (context) => {
	const root = await project(context, {}, []);
	const gated = workflow({
		name: "gate",
		entrypoint: false,
		args: Type.Object({ approved: Type.Boolean() }),
		gate: { enabled: true, fields: ["approved"] },
		execute: ({ run }) => run.complete(),
	});
	const engine = new NornEngine({ cwd: root, gateMode: "pause" });
	engine.registerWorkflows([gated]);
	const result = await engine.runWorkflow(
		gated,
		{ approved: false },
		undefined,
	);
	const runRoot = join(root, ".norn/runs", result.id);
	const checkpoints = await engine.listRunCheckpoints(runRoot);
	const path = join(runRoot, "current/run-state.json");
	const saved = JSON.parse(await readFile(path, "utf8"));
	saved.version = 1;
	saved.current.params = saved.current.args;
	delete saved.current.args;
	await writeFile(path, JSON.stringify(saved));
	await writeFile(join(runRoot, "current/state.json"), '{"legacy":"retained"}');
	const resumeRequest = JSON.stringify({
		version: 1,
		type: "resume",
		id: result.id,
		params: { approved: true },
		createdAt: new Date().toISOString(),
	});
	await writeFile(join(runRoot, "resume-request.json"), resumeRequest);
	const before = await readFile(path, "utf8");
	assert.equal((await getRunInfo(runRoot)).version, 1);
	assert.deepEqual((await getRunInfo(runRoot)).interruption?.args, {
		approved: false,
	});
	assert.equal((await listRuns(root)).length, 1);
	await assert.rejects(
		engine.resumeWorkflow(runRoot, { approved: true }),
		/Incompatible saved run/,
	);
	await assert.rejects(
		engine.rollbackRun(runRoot, checkpoints[0].id),
		/Incompatible saved run/,
	);
	assert.equal(await readFile(path, "utf8"), before);
	assert.equal(
		await readFile(join(runRoot, "resume-request.json"), "utf8"),
		resumeRequest,
	);
	assert.equal(
		await readFile(join(runRoot, "current/state.json"), "utf8"),
		'{"legacy":"retained"}',
	);
});

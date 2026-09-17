import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "vitest";
import { promisify } from "node:util";
import { findNornProject, loadNornProject } from "../packages/cli/src/plugin-loader.ts";
import { NornProjectLoadError } from "../packages/cli/src/internal/errors.ts";
import type { NornRunInfo, NornWorkflowCatalogInfo } from "@vimhead.dev/norn";
import { z } from "zod";
import { readProcessStdout } from "./helpers/process.ts";
const cliPath = fileURLToPath(new URL("../packages/cli/bin/norn.mjs", import.meta.url));
const executeFile = promisify(execFile);

async function createProjectFixture(context: TestContext) {
	const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "norn-project-config-")));
	context.onTestFinished(() => rm(projectRoot, { recursive: true, force: true }));
	return projectRoot;
}

async function writeJsonFixture({ path, value }: { path: string; value: unknown }) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(value));
}

async function writePluginFixture({ projectRoot, relativePath, pluginId, revision = "first" }: { projectRoot: string; relativePath: string; pluginId: string; revision?: string }) {
	const path = join(projectRoot, relativePath);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `
import { definePlugin, definePluginManifest } from "@vimhead.dev/norn";
import { z } from "zod";
const manifest = definePluginManifest({
	id: ${JSON.stringify(pluginId)},
	config: z.object({
		greeting: z.string().default("hello"),
		options: z.object({ keep: z.string(), replace: z.string() }).optional(),
	}),
	workflows: { echo: { instructions: "Use to echo the provided value.", isEntrypoint: true, params: z.object({ value: z.string() }) } },
});
export default definePlugin(manifest, { workflows: {
	echo: { execute: (run, params) => run.complete({ data: { value: params.value, revision: ${JSON.stringify(revision)} } }) },
} });
`);
}

async function executeCli<Output>({ cwd, args, input }: { cwd: string; args: readonly string[]; input?: unknown }): Promise<Output> {
	const execution = executeFile(process.execPath, [cliPath, ...args], { cwd, timeout: 20000, maxBuffer: 1024 * 1024 });
	assert.ok(execution.child.stdin);
	execution.child.stdin.end(input === undefined ? "" : JSON.stringify(input));
	const { stdout } = await execution;
	return JSON.parse(stdout);
}

test("a project file loads its own plugins, config and Seer policy from a nested cwd", async context => {
	const projectRoot = await createProjectFixture(context);
	const projectPath = join(projectRoot, "norn.project.json");
	await writePluginFixture({ projectRoot, relativePath: "workflows/plugin.ts", pluginId: "local" });
	await writeJsonFixture({ path: projectPath, value: {
		version: 1, plugins: ["./workflows/plugin.ts"], config: { local: { greeting: "project" } },
		seerMode: { writableRoots: ["./generated"] },
	} });
	const cwd = join(projectRoot, "nested/deeper");
	await mkdir(cwd, { recursive: true });
	const project = await loadNornProject(cwd);
	assert.equal(project.projectRoot, projectRoot);
	assert.deepEqual(project.config.plugins, ["./workflows/plugin.ts"]);
	assert.deepEqual(project.registry.list({ entrypointsOnly: true }).map(workflow => workflow.id), ["local.echo"]);
	assert.equal(project.pluginInfos[0].path, join(projectRoot, "workflows/plugin.ts"));
	assert.equal(project.pluginInfos[0].configPath, projectPath);
	assert.deepEqual(project.pluginInfos[0].config, { greeting: "project" });
	assert.deepEqual(project.configFiles.map(file => file.path), [projectPath]);
	assert.deepEqual(Object.keys(project.configFiles[0].config).sort(), ["config", "includes", "plugins"]);
	assert.deepEqual(project.seerMode, { configPath: projectPath, projectRoot, writableRoots: [join(projectRoot, "generated")] });
	await assert.rejects(stat(join(projectRoot, "norn.json")), { code: "ENOENT" });
});

test("local plugins compose with globbed and nested reusable configs, each relative to its declaring file", async context => {
	const projectRoot = await createProjectFixture(context);
	for (const [relativePath, pluginId] of [
		["plugin.ts", "local"], ["packages/a/plugin.ts", "packageA"],
		["packages/b/plugin.ts", "packageB"], ["shared/plugin.ts", "shared"],
	]) await writePluginFixture({ projectRoot, relativePath, pluginId });
	await writeJsonFixture({ path: join(projectRoot, "norn.project.json"), value: {
		version: 1, plugins: ["./plugin.ts"], includes: ["./packages/*/norn.json"],
		config: { local: { greeting: "project", options: { replace: "project" } }, packageA: { greeting: "project" } },
	} });
	for (const name of ["a", "b"]) {
		await writeJsonFixture({ path: join(projectRoot, "packages", name, "norn.json"), value: {
			plugins: ["./plugin.ts"], includes: ["../../shared/norn.json"],
		} });
	}
	await writeJsonFixture({ path: join(projectRoot, "shared/norn.json"), value: {
		plugins: ["./plugin.ts"], config: {
			local: { greeting: "shared", options: { keep: "shared", replace: "shared" } },
			packageA: { greeting: "shared" }, shared: { greeting: "shared" },
		},
	} });
	const project = await loadNornProject(join(projectRoot, "packages/a"));
	assert.deepEqual(project.pluginInfos.map(plugin => plugin.id).sort(), ["local", "packageA", "packageB", "shared"]);
	for (const plugin of project.pluginInfos) {
		assert.ok(plugin.path && plugin.configPath);
		assert.equal(dirname(plugin.path), dirname(plugin.configPath));
	}
	assert.deepEqual(project.pluginInfos.find(plugin => plugin.id === "local")?.config, {
		greeting: "project", options: { keep: "shared", replace: "project" },
	});
	assert.deepEqual(project.pluginInfos.find(plugin => plugin.id === "packageA")?.config, { greeting: "project" });
	assert.deepEqual(project.pluginInfos.find(plugin => plugin.id === "shared")?.config, { greeting: "shared" });
	assert.equal(project.configFiles.length, 4);
	assert.equal(project.seerMode, undefined);
});

test("the nearest project remains the execution boundary", async context => {
	const projectRoot = await createProjectFixture(context);
	await writeJsonFixture({ path: join(projectRoot, "norn.project.json"), value: { plugins: ["./missing-parent-plugin.ts"] } });
	const childRoot = join(projectRoot, "child");
	await writePluginFixture({ projectRoot: childRoot, relativePath: "plugin.ts", pluginId: "child" });
	await writeJsonFixture({ path: join(childRoot, "norn.project.json"), value: { plugins: ["./plugin.ts"] } });
	const project = await loadNornProject(childRoot);
	assert.equal(project.projectRoot, childRoot);
	assert.deepEqual(project.pluginInfos.map(plugin => plugin.id), ["child"]);
});

for (const plugins of ["./plugin.ts", [42], [""]]) {
	test(`invalid project plugins are rejected rather than discarded: ${JSON.stringify(plugins)}`, async context => {
		const projectRoot = await createProjectFixture(context);
		await writeJsonFixture({ path: join(projectRoot, "norn.project.json"), value: { plugins } });
		await assert.rejects(findNornProject(projectRoot), error => error instanceof z.ZodError && error.issues.some(issue => issue.path[0] === "plugins"));
	});
}

test("project-local plugin config is validated by its manifest", async context => {
	const projectRoot = await createProjectFixture(context);
	await writePluginFixture({ projectRoot, relativePath: "plugin.ts", pluginId: "local" });
	await writeJsonFixture({ path: join(projectRoot, "norn.project.json"), value: {
		plugins: ["./plugin.ts"], config: { local: { greeting: 42 } },
	} });
	await assert.rejects(loadNornProject(projectRoot), error => error instanceof NornProjectLoadError
		&& error.diagnostics.some(diagnostic => diagnostic.stage === "config" && diagnostic.issues.some(issue => issue.path[0] === "greeting")));
});

test("duplicate plugin ids across project and reusable configs are rejected", async context => {
	const projectRoot = await createProjectFixture(context);
	await writePluginFixture({ projectRoot, relativePath: "plugin.ts", pluginId: "duplicate" });
	await writePluginFixture({ projectRoot, relativePath: "shared/plugin.ts", pluginId: "duplicate" });
	await writeJsonFixture({ path: join(projectRoot, "norn.project.json"), value: {
		plugins: ["./plugin.ts"], includes: ["./shared/norn.json"],
	} });
	await writeJsonFixture({ path: join(projectRoot, "shared/norn.json"), value: { plugins: ["./plugin.ts"] } });
	await assert.rejects(loadNornProject(projectRoot), /Duplicate Norn plugin id: duplicate/);
});

test("an include cycle back to the project does not register its plugins twice", async context => {
	const projectRoot = await createProjectFixture(context);
	const projectPath = join(projectRoot, "norn.project.json");
	await writePluginFixture({ projectRoot, relativePath: "plugin.ts", pluginId: "local" });
	await writeJsonFixture({ path: projectPath, value: { plugins: ["./plugin.ts"], includes: ["./shared/norn.json"] } });
	await writeJsonFixture({ path: join(projectRoot, "shared/norn.json"), value: { includes: ["../norn.project.json"] } });
	const project = await loadNornProject(projectRoot);
	assert.deepEqual(project.pluginInfos.map(plugin => plugin.id), ["local"]);
	assert.deepEqual(project.configFiles.map(file => file.path), [projectPath, join(projectRoot, "shared/norn.json")]);
});

test("project overrides do not hide conflicts between reusable configs", async context => {
	const projectRoot = await createProjectFixture(context);
	await writeJsonFixture({ path: join(projectRoot, "norn.project.json"), value: {
		includes: ["./a.json", "./b.json"], config: { local: { greeting: "project" } },
	} });
	for (const name of ["a", "b"]) {
		await writeJsonFixture({ path: join(projectRoot, `${name}.json`), value: { config: { local: { greeting: name } } } });
	}
	await assert.rejects(findNornProject(projectRoot), /Conflicting Norn reusable config at config.local.greeting/);
});

test("init is self-contained and supports authoring and executing directly afterward", { timeout: 30000 }, async context => {
	const projectRoot = await createProjectFixture(context);
	await executeCli({ cwd: projectRoot, args: ["project", "init"], input: undefined });
	const projectPath = join(projectRoot, "norn.project.json");
	const config = JSON.parse(await readFile(projectPath, "utf8"));
	assert.deepEqual(config, { version: 1, plugins: [] as string[], includes: [] as string[], config: {} });
	assert.equal((await stat(join(projectRoot, ".norn/runs"))).isDirectory(), true);
	await assert.rejects(stat(join(projectRoot, "norn.json")), { code: "ENOENT" });
	const emptyProject = await loadNornProject(projectRoot);
	assert.deepEqual(emptyProject.pluginInfos, []);
	config.plugins.push("./plugin.ts");
	await writeJsonFixture({ path: projectPath, value: config });
	for (const revision of ["first", "second"]) {
		await writePluginFixture({ projectRoot, relativePath: "plugin.ts", pluginId: "local", revision });
		const { workflows } = await executeCli<NornWorkflowCatalogInfo>({ cwd: projectRoot, args: ["workflows", "list"], input: undefined });
		assert.deepEqual(workflows.map(workflow => workflow.id), ["local.echo"]);
		const { run } = await executeCli<{ run: NornRunInfo }>({ cwd: projectRoot, args: ["runs", "start", "local.echo"], input: { params: { value: "saved" } } });
		const finished = await executeCli<{ run: NornRunInfo }>({ cwd: projectRoot, args: ["runs", "wait", run.id], input: undefined });
		assert.equal(finished.run.status, "completed");
		assert.deepEqual(finished.run.outcome?.metadata?.data, { value: "saved", revision });
	}
	await assert.rejects(executeCli({ cwd: projectRoot, args: ["project", "init"], input: undefined }), error => /Norn project already exists/.test(readProcessStdout(error)));
	assert.deepEqual(JSON.parse(await readFile(projectPath, "utf8")), config);
});

for (const siblingTiming of ["before", "after"]) {
	test(`a sibling norn.json created ${siblingTiming} init is not implicitly included`, { timeout: 10000 }, async context => {
		const projectRoot = await createProjectFixture(context);
		const siblingPath = join(projectRoot, "norn.json");
		if (siblingTiming === "before") await writeFile(siblingPath, "invalid JSON that must not be read or changed");
		await executeCli({ cwd: projectRoot, args: ["project", "init"], input: undefined });
		if (siblingTiming === "after") await writeFile(siblingPath, "invalid JSON that must not be read or changed");
		const project = await loadNornProject(projectRoot);
		assert.deepEqual(project.config.includes, []);
		assert.deepEqual(project.pluginInfos, []);
		assert.equal(await readFile(siblingPath, "utf8"), "invalid JSON that must not be read or changed");
	});
}

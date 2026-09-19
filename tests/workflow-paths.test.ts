import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { Type } from "typebox";
import { test, type TestContext } from "vitest";
import { workflow, workflowScope, type NornWorkflowPaths } from "@vimhead.dev/norn";
import { NornEngine } from "../packages/cli/src/internal/engine.ts";

async function createDirectory(context: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "norn-paths-")));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("standalone execution, scoped gates, and resumed execution share absolute paths with distinct rollback behavior", async context => {
	const project = await createDirectory(context);
	await writeFile(join(project, "source.txt"), "original project");
	const expectedPaths: NornWorkflowPaths = { project, workspace: join(project, ".norn/runs/paths/current/workspace") };
	const scope = workflowScope({ id: "paths" });
	const finish = scope.workflow({
		id: "finish", isEntrypoint: false, args: Type.Object({}),
		gate: { enabled: true, describe({ scope, paths }) {
			assert.equal(scope.id, "paths");
			assert.deepEqual(paths, expectedPaths);
			return JSON.stringify(paths);
		} },
		async execute({ paths, run }) {
			assert.deepEqual(paths, expectedPaths);
			await writeFile(join(paths.project, "source.txt"), "changed project");
			await writeFile(join(paths.workspace, "work.txt"), "changed workspace");
			await writeFile(join(paths.workspace, "new.txt"), "created after checkpoint");
			return run.complete();
		},
	});
	const start = workflow({
		id: "start", isEntrypoint: false, args: Type.Object({}),
		async execute({ paths }) {
			assert.deepEqual(paths, expectedPaths);
			assert.ok(isAbsolute(paths.project) && isAbsolute(paths.workspace));
			assert.deepEqual(await readdir(paths.workspace), []);
			await writeFile(join(paths.workspace, "work.txt"), "checkpoint workspace");
			return finish({});
		},
	});
	const engine = new NornEngine({ cwd: relative(process.cwd(), project), gateMode: "pause" });
	engine.registerWorkflows([start, finish]);
	const interrupted = await engine.runWorkflow(start, {}, { id: "paths" });
	assert.equal(interrupted.status, "interrupted");
	assert.deepEqual(JSON.parse(interrupted.interruption.description), expectedPaths);
	const runRoot = join(project, ".norn/runs/paths");
	const checkpoints = await engine.listRunCheckpoints(runRoot);
	const checkpoint = checkpoints.at(-1)!;
	const reopened = new NornEngine({ cwd: project, gateMode: "pause" });
	reopened.registerWorkflows([start, finish]);
	assert.equal((await reopened.resumeWorkflow(runRoot, {})).status, "completed");
	assert.equal(await readFile(join(expectedPaths.workspace, "work.txt"), "utf8"), "changed workspace");
	assert.equal((await reopened.rollbackRun(runRoot, checkpoint.id)).status, "interrupted");
	assert.equal(await readFile(join(expectedPaths.workspace, "work.txt"), "utf8"), "checkpoint workspace");
	await assert.rejects(readFile(join(expectedPaths.workspace, "new.txt")), { code: "ENOENT" });
	assert.equal(await readFile(join(project, "source.txt"), "utf8"), "changed project");
	assert.equal((await reopened.resumeWorkflow(runRoot, {})).status, "completed");
});

test("one workflow chooses project, run, and external command directories explicitly", async context => {
	const project = await createDirectory(context);
	const external = await createDirectory(context);
	const check = workflow({
		id: "directories", isEntrypoint: false, args: Type.Object({}),
		async execute({ paths, run }) {
			for (const cwd of [paths.project, paths.workspace, external]) {
				const result = await run.commands.run({ label: "pwd", cwd, command: [process.execPath, "-e", "process.stdout.write(process.cwd())"] });
				assert.equal(result.exitCode, 0);
				assert.equal(result.cwd, cwd);
				assert.equal(result.stdoutTail, cwd);
			}
			return run.complete();
		},
	});
	const engine = new NornEngine({ cwd: project });
	engine.registerWorkflows([check]);
	assert.equal((await engine.runWorkflow(check, {}, undefined)).status, "completed");
});

test("commands and agents reject missing or relative cwd rather than selecting an implicit directory", async context => {
	const project = await createDirectory(context);
	const check = workflow({
		id: "explicit-cwd", isEntrypoint: false, args: Type.Object({}),
		async execute({ run }) {
			for (const cwd of [undefined, "", ".", "../other"]) {
				await assert.rejects(Reflect.apply(run.commands.run, undefined, [{ label: "invalid", cwd, command: [process.execPath, "--version"] }]), /cwd.*must be an absolute path/);
				await assert.rejects(Reflect.apply(run.agents.createSession, undefined, [{ label: "invalid", cwd }]), /cwd.*must be an absolute path/);
			}
			return run.complete();
		},
	});
	const engine = new NornEngine({ cwd: project });
	engine.registerWorkflows([check]);
	assert.equal((await engine.runWorkflow(check, {}, undefined)).status, "completed");
});

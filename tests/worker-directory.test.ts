import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test, type TestContext } from "vitest";
import type { NornRunInfo } from "@vimhead.dev/norn";
import { prepareRunWorkerDirectory } from "../packages/cli/src/internal/worker-directory.ts";

const execute = promisify(execFile);
const cliPath = fileURLToPath(new URL("../packages/cli/bin/norn.mjs", import.meta.url));

async function fixture(context: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "norn-worker-cwd-")));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("worker cwd is empty, read-only, reusable, and does not change the caller cwd", async context => {
	const root = await fixture(context);
	const callerCwd = process.cwd();
	const directory = await prepareRunWorkerDirectory(root);
	assert.deepEqual(await readdir(directory), []);
	if (process.platform !== "win32") assert.equal((await stat(directory)).mode & 0o222, 0);
	assert.equal(await prepareRunWorkerDirectory(root), directory);
	assert.equal(process.cwd(), callerCwd);
});

test("worker cwd preparation rejects symlinks without changing their target permissions", async context => {
	const root = await fixture(context);
	const target = join(root, "target");
	await mkdir(target);
	const mode = (await stat(target)).mode;
	await symlink(target, join(root, "worker"), process.platform === "win32" ? "junction" : "dir");
	await assert.rejects(prepareRunWorkerDirectory(root), /not a symlink/);
	assert.equal((await stat(target)).mode, mode);
});

test("worker cwd preparation preserves and rejects unexpected contents", async context => {
	const root = await fixture(context);
	await mkdir(join(root, "worker"));
	await writeFile(join(root, "worker", "evidence"), "retain");
	await assert.rejects(prepareRunWorkerDirectory(root), /must be empty/);
	assert.equal(await readFile(join(root, "worker", "evidence"), "utf8"), "retain");
});

test("detached start and resume use per-run guarded cwd without changing project files", { timeout: 45000 }, async context => {
	const project = await fixture(context);
	await writeFile(join(project, "source.txt"), "project evidence");
	await writeFile(join(project, "norn.project.json"), JSON.stringify({ workflows: ["./workflow.ts"] }));
	await writeFile(join(project, "workflow.ts"), `
import assert from "node:assert/strict";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflow } from "@vimhead.dev/norn";
import { Type } from "typebox";
const importCwd = process.cwd();
async function verifyCwd(paths) {
  const cwd = process.cwd();
  assert.equal(cwd, importCwd);
  assert.notEqual(cwd, paths.project);
  assert.notEqual(cwd, paths.workspace);
  assert.deepEqual(await readdir(cwd), []);
  await assert.rejects(unlink("source.txt"), { code: "ENOENT" });
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    await assert.rejects(writeFile("source.txt", "accidental overwrite"), error => error.code === "EACCES" || error.code === "EPERM");
  }
  assert.equal(await readFile(join(paths.project, "source.txt"), "utf8"), "project evidence");
  return cwd;
}
const start = workflow({
  id: "start", isEntrypoint: true, instructions: "Check execution directories.", args: Type.Object({}),
  async execute({ paths, run }) {
    const cwd = await verifyCwd(paths);
    await writeFile(join(paths.workspace, "start.txt"), cwd);
    return finish({});
  },
});
const finish = workflow({
  id: "finish", isEntrypoint: false, args: Type.Object({}),
  gate: { enabled: true, async describe({ paths }) { return await verifyCwd(paths); } },
  async execute({ paths, run }) {
    const cwd = await verifyCwd(paths);
    assert.equal(await readFile(join(paths.workspace, "start.txt"), "utf8"), cwd);
    await writeFile(join(paths.workspace, "finish.txt"), cwd);
    return run.complete({ data: { cwd, paths } });
  },
});
export default [start, finish];
`);
	const invoke = async <Output = { run: NornRunInfo }>(args: string[], input: unknown): Promise<Output> => {
		const child = execute(process.execPath, [cliPath, ...args], { cwd: project, timeout: 30000 });
		child.child.stdin!.end(input === undefined ? "" : JSON.stringify(input));
		return JSON.parse((await child).stdout);
	};
	const launches = await Promise.all([1, 2].map(() => invoke(["runs", "start", "start"], { args: {} })));
	for (const { run } of launches) {
		const paths = { project, workspace: join(run.path, "current/workspace") };
		assert.deepEqual(run.paths, paths);
		const paused = (await invoke(["runs", "wait", run.id], undefined)).run;
		assert.equal(paused.status, "interrupted", JSON.stringify(paused));
		assert.deepEqual(paused.paths, paths);
		assert.equal(paused.interruption?.description, join(run.path, "worker"));
		assert.deepEqual((await invoke(["runs", "inspect", run.id], undefined)).run.paths, paths);
	}
	const listed = await invoke<{ runs: NornRunInfo[] }>(["runs", "list"], undefined);
	for (const run of listed.runs) assert.deepEqual(run.paths, { project, workspace: join(run.path, "current/workspace") });
	await Promise.all(launches.map(({ run }) => invoke(["runs", "resume", run.id], { args: {} })));
	for (const { run } of launches) {
		const completed = (await invoke(["runs", "wait", run.id], undefined)).run;
		assert.equal(completed.status, "completed", JSON.stringify(completed));
		assert.deepEqual(completed.paths, run.paths);
		assert.deepEqual(completed.outcome?.metadata?.data, { cwd: join(run.path, "worker"), paths: { project, workspace: join(run.path, "current/workspace") } });
	}
	assert.equal(await readFile(join(project, "source.txt"), "utf8"), "project evidence");
	await assert.rejects(readFile(join(project, "start.txt")), { code: "ENOENT" });
});

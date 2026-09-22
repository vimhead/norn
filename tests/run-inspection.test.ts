import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test, vi } from "vitest";
import {
	NornRunStateStore,
	getRunInfo,
	RUN_STATE_FILE_NAME,
} from "../packages/cli/src/internal/run-state.ts";
import {
	writeRunLaunchRequest,
	writeRunResumeRequest,
	RESUME_REQUEST_FILE_NAME,
} from "../packages/cli/src/internal/launch-request.ts";

const originalReadFile = fs.readFile;
let readFileOverride:
	| ((
			...args: Parameters<typeof fs.readFile>
	  ) => ReturnType<typeof fs.readFile>)
	| undefined;
vi.spyOn(fs, "readFile").mockImplementation((...args) =>
	readFileOverride ? readFileOverride(...args) : originalReadFile(...args),
);
syncBuiltinESMExports();
afterAll(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
});

test("inspection cannot pair an old interruption with a just-cleared resume request", async (context) => {
	const root = await fs.mkdtemp(join(tmpdir(), "norn-inspection-race-test-"));
	context.onTestFinished(() => {
		readFileOverride = undefined;
		return fs.rm(root, { recursive: true, force: true });
	});
	const state = await NornRunStateStore.create(root, {
		projectRoot: root,
		id: "race",
		name: "race",
		entrypointWorkflowId: "test.step",
		workspace: join(root, "current/workspace"),
		current: { workflowId: "test.step", args: {}, cwd: root, env: {} },
		startedAt: new Date().toISOString(),
	});
	await state.interruptCurrent({}, { description: "Old interruption" });
	await writeRunResumeRequest(root, {
		version: 2,
		type: "resume",
		id: "race",
		createdAt: new Date().toISOString(),
	});
	const statePath = join(root, "current", RUN_STATE_FILE_NAME);
	const requestPath = join(root, RESUME_REQUEST_FILE_NAME);
	const oldState = await fs.readFile(statePath, "utf8");
	let isHandoffComplete = false;
	readFileOverride = async (path, ...args) => {
		if (path === statePath && !isHandoffComplete) return oldState;
		if (path === requestPath) {
			await state.completeRun("test.step", {
				summary: "New execution completed",
			});
			await fs.rm(requestPath);
			isHandoffComplete = true;
		}
		return originalReadFile(path, ...args);
	};
	const inspected = await getRunInfo(root);
	assert.equal(inspected.status, "completed");
	assert.deepEqual(inspected.paths, {
		project: root,
		workspace: join(root, "current/workspace"),
	});
	assert.equal(isHandoffComplete, true);
});

test("older saved runs expose their paths without rewriting saved state", async (context) => {
	const project = await fs.mkdtemp(join(tmpdir(), "norn-saved-paths-"));
	context.onTestFinished(() =>
		fs.rm(project, { recursive: true, force: true }),
	);
	const runRoot = join(project, ".norn/runs/saved");
	const workspace = join(runRoot, "current/workspace");
	await NornRunStateStore.create(runRoot, {
		projectRoot: project,
		id: "saved",
		name: "saved",
		entrypointWorkflowId: "test.step",
		workspace,
		current: { workflowId: "test.step", args: {}, cwd: workspace, env: {} },
		startedAt: new Date().toISOString(),
	});
	const statePath = join(runRoot, "current", RUN_STATE_FILE_NAME);
	const state = JSON.parse(await fs.readFile(statePath, "utf8"));
	delete state.projectRoot;
	const original = JSON.stringify(state);
	await fs.writeFile(statePath, original);
	assert.deepEqual((await getRunInfo(runRoot)).paths, { project, workspace });
	assert.equal(await fs.readFile(statePath, "utf8"), original);
});

test("a pending launch exposes project and workspace paths before execution creates state", async (context) => {
	const project = await fs.mkdtemp(join(tmpdir(), "norn-launch-paths-"));
	context.onTestFinished(() =>
		fs.rm(project, { recursive: true, force: true }),
	);
	const runRoot = join(project, ".norn/runs/pending");
	await writeRunLaunchRequest(runRoot, {
		version: 2,
		type: "run",
		id: "pending",
		name: "pending",
		workflowId: "test.step",
		args: {},
		createdAt: new Date().toISOString(),
	});
	const info = await getRunInfo(runRoot);
	assert.equal(info.status, "running");
	assert.deepEqual(info.paths, {
		project,
		workspace: join(runRoot, "current/workspace"),
	});
});

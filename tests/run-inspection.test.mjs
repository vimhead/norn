import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import { createJiti } from "jiti";

const originalReadFile = fs.readFile;
let readFileOverride;
mock.method(fs, "readFile", (...args) => readFileOverride ? readFileOverride(...args) : originalReadFile(...args));
syncBuiltinESMExports();
after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { NornRunStateStore, getRunInfo, RUN_STATE_FILE_NAME } = await jiti.import("../src/internal/run-state.ts");
const { writeRunResumeRequest, RESUME_REQUEST_FILE_NAME } = await jiti.import("../src/internal/launch-request.ts");

test("inspection cannot pair an old interruption with a just-cleared resume request", async context => {
	const root = await fs.mkdtemp(join(tmpdir(), "norn-inspection-race-test-"));
	context.after(() => { readFileOverride = undefined; return fs.rm(root, { recursive: true, force: true }); });
	const state = await NornRunStateStore.create(root, {
		id: "race", name: "race", entrypointWorkflowId: "test.step", workspace: join(root, "current/workspace"),
		current: { workflowId: "test.step", params: {}, cwd: root, env: {} }, startedAt: new Date().toISOString(),
	});
	await state.interruptCurrent({}, { description: "Old interruption" });
	await writeRunResumeRequest(root, { version: 1, type: "resume", id: "race", createdAt: new Date().toISOString() });
	const statePath = join(root, "current", RUN_STATE_FILE_NAME);
	const requestPath = join(root, RESUME_REQUEST_FILE_NAME);
	const oldState = await fs.readFile(statePath, "utf8");
	let isHandoffComplete = false;
	readFileOverride = async (path, ...args) => {
		if (path === statePath && !isHandoffComplete) return oldState;
		if (path === requestPath) {
			await state.completeRun("test.step", { summary: "New execution completed" });
			await fs.rm(requestPath);
			isHandoffComplete = true;
		}
		return originalReadFile(path, ...args);
	};
	assert.equal((await getRunInfo(root)).status, "completed");
	assert.equal(isHandoffComplete, true);
});

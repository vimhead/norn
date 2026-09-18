import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StateAdapter, definePlugin, definePluginManifest, type NornResources, type NornWorkflowState } from "@vimhead.dev/norn";
import { NornFileCoordinator, createRunFileCoordinator } from "@vimhead.dev/norn/files";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { test, type TestContext } from "vitest";
import { NornArtifacts } from "../packages/cli/src/internal/artifacts.ts";
import { NornEngine } from "../packages/cli/src/internal/engine.ts";
import { NornRunLogger } from "../packages/cli/src/internal/run-log.ts";
import { initializeRunResources } from "../packages/cli/src/internal/run-resources.ts";
import { NornRunStateStore } from "../packages/cli/src/internal/run-state.ts";
import { NornRunStore } from "../packages/cli/src/internal/run-store.ts";
import { NornMemoryWorkflowState } from "../packages/cli/src/internal/state-store.ts";
import { NornRunResources } from "../packages/cli/src/resources.ts";

async function fixture(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "norn-resources-"));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "current"));
	await writeFile(join(root, "counter.json"), "0");
	return { root, files: createRunFileCoordinator(root), target: join(root, "counter.json") };
}

function worker(root: string, mode: string, name: string) {
	const child = spawn(process.execPath, ["--input-type=module", "--eval", 'import { createJiti } from "jiti"; await createJiti(import.meta.url, { moduleCache: false }).import(process.argv[1]);', fileURLToPath(new URL("./fixtures/file-lock-worker.ts", import.meta.url)), root, mode, name], { stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.on("data", chunk => { stderr += chunk; });
	const completed = new Promise<void>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code, signal) => code === 0 || signal === "SIGKILL" ? resolve() : reject(new Error(stderr || `Worker exited: ${code}`)));
	});
	return { child, completed };
}

test("independent processes serialize whole mutations and recover a dead owner with competing waiters", { timeout: 15000 }, async context => {
	const { root, target } = await fixture(context);
	const holder = worker(root, "hold", "holder");
	context.onTestFinished(async () => { holder.child.kill("SIGKILL"); await holder.completed; });
	await Promise.race([new Promise<void>(resolve => holder.child.stdout.once("data", () => resolve())), holder.completed.then(() => { throw new Error("Holder exited before acquiring"); })]);
	const shortWait = new NornFileCoordinator({ lockRoot: join(root, "locks"), waitTimeoutMs: 40 });
	await assert.rejects(shortWait.readText(target), /Timed out/);
	holder.child.kill("SIGKILL");
	await holder.completed;
	await Promise.all(Array.from({ length: 4 }, (_, index) => worker(root, "counter", `${index}`).completed));
	assert.equal(JSON.parse(await readFile(target, "utf8")), 48);
	assert.deepEqual(await readdir(join(root, "locks")), []);
});

test("independent state processes preserve every field and initialization never seeds declared defaults", { timeout: 15000 }, async context => {
	const { root } = await fixture(context);
	await Promise.all(Array.from({ length: 4 }, (_, index) => worker(root, "state", `${index}`).completed));
	const { state } = await initializeRunResources(root);
	assert.equal(Object.keys(JSON.parse(await readFile(state.stateFile, "utf8"))).length, 48);
	assert.equal(await state.getOptional({ id: "missing", schema: Type.String({ default: "not invented" }) }), undefined);
	await assert.rejects(state.get({ id: "missing", schema: Type.String() }), /Missing workflow state/);
});

test("locks coordinate canonical aliases, release after exceptions, and do not block unrelated files", async context => {
	const { root, files, target } = await fixture(context);
	const alias = join(root, "alias.json");
	await symlink(target, alias);
	await assert.rejects(files.withExclusiveLock(alias, async path => {
		assert.equal(path, await realpath(target));
		await files.writeText(join(root, "unrelated.json"), "other");
		const competing = new NornFileCoordinator({ lockRoot: join(root, "locks"), waitTimeoutMs: 30 });
		await assert.rejects(competing.readText(target), /Timed out/);
		throw new Error("operation failed");
	}), /operation failed/);
	await files.writeText(alias, "1");
	assert.equal(await files.readText(target), "1");
});

test("malformed ownership fails closed", async context => {
	const { root, files, target } = await fixture(context);
	await files.withExclusiveLock(target, async () => {
		const [directory] = (await readdir(join(root, "locks"))).filter(name => name.endsWith(".lock"));
		const [marker] = await readdir(join(root, "locks", directory));
		await writeFile(join(root, "locks", directory, marker), "{}");
		await assert.rejects(files.readText(target));
	});
});

test("state rejects invalid documents and failed writes do not poison subsequent operations", async context => {
	const { root } = await fixture(context);
	const { state } = await initializeRunResources(root);
	const field = { id: "count", schema: Type.Integer() };
	await assert.rejects(state.set(field, 1.5));
	await state.set(field, 2);
	assert.equal(await state.get(field), 2);
	await writeFile(state.stateFile, "[]");
	await assert.rejects(state.set(field, 3), /Invalid workflow state document/);
	assert.equal(await readFile(state.stateFile, "utf8"), "[]");
	await writeFile(state.stateFile, "{}");
	await state.set({ id: "__proto__", schema: Type.String() }, "ordinary field");
	assert.equal(await state.get({ id: "__proto__", schema: Type.String() }), "ordinary field");
});

test("workflow and adapter writes share Pi file-mutation coordination", async context => {
	const { root } = await fixture(context);
	const { state } = await initializeRunResources(root);
	const field = { id: "count", schema: Type.Number() };
	await state.set(field, 0);
	const binding = await StateAdapter({ state, fields: [{ field, access: "write" }] }).bind({ runId: "test", label: "writer" });
	const writeTool = binding.tools.find(tool => tool.name === "norn_state_set")!;
	let markEntered!: () => void;
	let releaseQueue!: () => void;
	const entered = new Promise<void>(resolve => { markEntered = resolve; });
	const released = new Promise<void>(resolve => { releaseQueue = resolve; });
	const held = withFileMutationQueue(state.stateFile, async () => {
		markEntered();
		await released;
	});
	await entered;
	const workflowWrite = state.set(field, 1);
	const adapterWrite = writeTool.execute("write", { key: field.id, value: 2 }, undefined, undefined, {} as never);
	try {
		await delay(25);
		assert.equal(await state.get(field), 0);
	} finally {
		releaseQueue();
		await Promise.all([held, workflowWrite, adapterWrite]);
		await binding.dispose();
	}
	assert.equal(await state.get(field), 2);
});

test("StateAdapter delegates to the state interface without filesystem metadata", async () => {
	const state = new NornMemoryWorkflowState();
	const field = { id: "message", schema: Type.String() };
	const binding = await StateAdapter({ state, fields: [{ field, access: "read-write" }] }).bind({ runId: "test", label: "memory" });
	try {
		const set = binding.tools.find(tool => tool.name === "norn_state_set")!;
		const get = binding.tools.find(tool => tool.name === "norn_state_get")!;
		await set.execute("write", { key: field.id, value: "saved" }, undefined, undefined, {} as never);
		const result = await get.execute("read", { key: field.id, offset: 0, limit: 10000 }, undefined, undefined, {} as never);
		assert.deepEqual(JSON.parse((result.details as { text: string }).text), { isSet: true, value: "saved" });
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(set.execute("cancelled", { key: field.id, value: "cancelled" }, controller.signal, undefined, {} as never));
		assert.equal(await state.get(field), "saved");
	} finally {
		await binding.dispose();
	}
});

test("resource identity survives reopening, rejects conflicts and permits a failed initializer to retry", async context => {
	const { root } = await fixture(context);
	const resources = await NornRunResources.initialize(root);
	let attempts = 0;
	const definition = { name: "notes", kind: "test.notes", configuration: { format: 1 }, async initialize() { attempts++; if (attempts === 1) throw new Error("interrupted initialization"); return { ready: true }; } };
	await assert.rejects(resources.ensure(definition), /interrupted/);
	const handle = await resources.ensure(definition);
	assert.strictEqual(await resources.ensure(definition), handle);
	assert.equal(attempts, 2);
	await assert.rejects(resources.ensure({ ...definition, configuration: { format: 2 } }), /Incompatible/);
	const reopened = await NornRunResources.initialize(root);
	await assert.rejects(reopened.ensure({ ...definition, configuration: { format: 2 } }), /Incompatible/);
	await assert.rejects(reopened.ensure({ ...definition, name: "../escape" }), /Invalid resource name/);
});

test("independent logger handles append without losing events", async context => {
	const { root, files } = await fixture(context);
	const manifestPath = join(root, "current", "manifest.json");
	const first = new NornRunLogger({ manifestPath, files, manifest: { id: "test", name: "test", workflowId: "test.step", runRoot: root, workspace: root, initialCwd: root, startedAt: new Date().toISOString() } });
	await first.record({ type: "initial" });
	const second = await NornRunLogger.load(manifestPath, createRunFileCoordinator(root));
	await Promise.all(Array.from({ length: 30 }, (_, index) => (index % 2 ? first : second).record({ type: "event", index })));
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	assert.equal(manifest.events.length, 31);
	assert.equal(new Set(manifest.events.slice(1).map((event: { index: number }) => event.index)).size, 30);
});

test("checkpoint rollback restores resource data but never restores transient lock ownership", async context => {
	const { root } = await fixture(context);
	const store = await NornRunStore.initialize(root);
	const { resources, state } = await initializeRunResources(root);
	const field = { id: "phase", schema: Type.String() };
	await state.set(field, "before");
	const checkpoint = await resources.files.withExclusiveLock(state.stateFile, async () => store.snapshotCurrent("saved"));
	await state.set(field, "after");
	await store.restoreSnapshot(checkpoint.id, undefined);
	const reopened = await initializeRunResources(root);
	assert.equal(await reopened.state.get(field), "before");
	assert.deepEqual(await readdir(join(root, "locks")), []);
});

test("StateAdapter accepts public state, scopes tools, validates schemas and paginates large values", async context => {
	const { root } = await fixture(context);
	const state: NornWorkflowState = (await initializeRunResources(root)).state;
	const visible = { id: "visible", schema: Type.String() };
	const hidden = { id: "hidden", schema: Type.String() };
	await state.set(hidden, "secret context");
	await state.set(visible, "a".repeat(20000));
	const binding = await StateAdapter({ state, fields: [{ field: visible, access: "read" }] }).bind({ runId: "test", label: "reader" });
	const execute = async (name: string, params: object) => binding.tools.find(tool => tool.name === name)!.execute("call", params, undefined, undefined, {} as never);
	const listed = await execute("norn_state_list", { offset: 0, limit: 10000 });
	assert.ok(JSON.stringify(listed.content).includes("visible"));
	assert.ok(!JSON.stringify(listed.content).includes("hidden"));
	await assert.rejects(execute("norn_state_get", { key: "hidden", offset: 0, limit: 10000 }), /not attached/);
	await assert.rejects(execute("norn_state_set", { key: "visible", value: "changed" }), /not attached/);
	const first = await execute("norn_state_get", { key: "visible", offset: 0, limit: 10000 });
	const details = first.details as { nextOffset: number; revision: string; text: string };
	assert.equal(details.nextOffset, 10000);
	assert.ok(Buffer.byteLength(JSON.stringify(first.content)) < 50000);
	await binding.dispose();
	const writer = await StateAdapter({ state, fields: [{ field: visible, access: "write" }] }).bind({ runId: "test", label: "writer" });
	await assert.rejects(writer.tools.find(tool => tool.name === "norn_state_set")!.execute("call", { key: "visible", value: 3 }, undefined, undefined, {} as never));
	assert.equal((await state.get(visible)).length, 20000);
});

test("reopening initialized state never substitutes empty data for a missing file", async context => {
	const { root } = await fixture(context);
	const { state } = await initializeRunResources(root);
	await rm(state.stateFile);
	await assert.rejects(state.getOptional({ id: "missing", schema: Type.String() }), { code: "ENOENT" });
	await assert.rejects(initializeRunResources(root), { code: "ENOENT" });
	await assert.rejects(readFile(state.stateFile), { code: "ENOENT" });
});

test("lock cleanup preserves both an operation error and lost ownership evidence", async context => {
	const { root, files, target } = await fixture(context);
	await assert.rejects(files.withExclusiveLock(target, async () => {
		const [directory] = (await readdir(join(root, "locks"))).filter(name => name.endsWith(".lock"));
		await rm(join(root, "locks", directory), { recursive: true });
		throw new Error("original failure");
	}), error => {
		assert.ok(error instanceof AggregateError);
		assert.equal(error.errors.length, 2);
		assert.equal(error.errors[0].message, "original failure");
		assert.equal(error.errors[1].code, "ENOENT");
		return true;
	});
	assert.equal(await files.readText(target), "0");
});

test("replaceable artifact reads observe complete values across independent writers", async context => {
	const { root, files } = await fixture(context);
	const path = join(root, "current", "artifacts");
	const first = new NornArtifacts(path, files);
	const second = new NornArtifacts(path, createRunFileCoordinator(root));
	const values = ["a".repeat(100000), "б".repeat(100000)];
	const reference = await first.write("shared.txt", values[0]);
	await chmod(join(path, reference.path), 0o640);
	await Promise.all(Array.from({ length: 12 }, async (_, index) => {
		await second.write(reference.path, values[index % 2]);
		assert.ok(values.includes(await first.read(reference)));
	}));
	assert.equal((await stat(join(path, reference.path))).mode & 0o777, 0o640);
});

test("native workflow contexts share one state resource and resume reopens its persisted values", async context => {
	const { root } = await fixture(context);
	const manifest = definePluginManifest({
		id: "resourceLifecycle",
		states: { value: Type.Number() },
		workflows: {
			start: { isEntrypoint: true, instructions: "Exercise resource lifecycle.", params: Type.Object({}) },
			continue: { isEntrypoint: false, params: Type.Object({}) },
			finish: { isEntrypoint: false, params: Type.Object({ decision: Type.Enum(["accept", "reject"]) }), gate: { enabled: true, fields: ["decision"] } },
		},
	});
	let manager: NornResources | undefined;
	let initialState: NornWorkflowState | undefined;
	const plugin = definePlugin(manifest, { workflows: {
		start: { async execute(run) {
			initialState = run.state;
			const managedState = await run.resources.ensure<NornWorkflowState>({
				name: "workflow-state", kind: "norn.state", configuration: { format: 1, path: "state.json" },
				async initialize() { throw new Error("Built-in state must already be initialized"); },
			});
			assert.strictEqual(managedState, run.state);
			assert.equal(await run.state.getOptional(manifest.states.value), undefined);
			manager = run.resources;
			await run.state.set(manifest.states.value, 7);
			return run.next(manifest.workflows.continue, {});
		} },
		continue: { execute(run) {
			assert.strictEqual(run.resources, manager);
			assert.strictEqual(run.state, initialState);
			return run.next(manifest.workflows.finish, { decision: "reject" });
		} },
		finish: { gate: { describe: () => "Accept the persisted value." }, async execute(run) {
			assert.notStrictEqual(run.resources, manager);
			assert.notStrictEqual(run.state, initialState);
			return run.complete({ data: { value: await run.state.get(manifest.states.value) } });
		} },
	} });
	const engine = new NornEngine({ cwd: root, gateMode: "pause" });
	engine.registerPlugin(plugin);
	const interrupted = await engine.runWorkflow(manifest.workflows.start, {}, undefined);
	assert.equal(interrupted.status, "interrupted");
	const resumedEngine = new NornEngine({ cwd: root, gateMode: "pause" });
	resumedEngine.registerPlugin(plugin);
	const completed = await resumedEngine.resumeWorkflow(join(root, ".norn", "runs", interrupted.id), { decision: "accept" });
	assert.equal(completed.status, "completed");
	assert.deepEqual(completed.metadata?.data, { value: 7 });
});

for (const layout of ["symlink", "legacy"] as const) {
	test(`scheduler locking retains ${layout} state loading and writes`, async context => {
		const { root } = await fixture(context);
		await NornRunStateStore.create(root, {
			id: "layout", name: "layout", entrypointWorkflowId: "test.step", workspace: root,
			current: { workflowId: "test.step", params: {}, cwd: root, env: {} }, startedAt: new Date().toISOString(),
		});
		const currentPath = join(root, "current", "run-state.json");
		const target = layout === "symlink" ? join(root, "different-name.json") : join(root, "current", "runtime-state.json");
		await rename(currentPath, target);
		if (layout === "symlink") await symlink(target, currentPath);
		const reopened = await NornRunStateStore.load(root);
		await reopened.stopCurrent();
		assert.equal((await NornRunStateStore.load(root)).currentState().status, "stopped");
		assert.equal(JSON.parse(await readFile(currentPath, "utf8")).status, "stopped");
		if (layout === "symlink") assert.equal(await realpath(currentPath), await realpath(target));
	});
}

import { createStateTools } from "../examples/shared-state/state-tools.ts";
import { SharedState, type SharedStateAccess } from "../examples/shared-state/shared-state.ts";
import { workflowScope } from "@vimhead.dev/norn";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { test, type TestContext } from "vitest";
import { NornEngine } from "../packages/cli/src/internal/engine.ts";
import { NornRunStore } from "../packages/cli/src/internal/run-store.ts";
import { initializeSharedState } from "./helpers/shared-state.ts";

async function fixture(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "norn-shared-state-"));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const { state, path } = await initializeSharedState(root);
	context.onTestFinished(() => state.close());
	return { root, state, path };
}

test("independent state processes preserve every field without seeding defaults", { timeout: 15000 }, async context => {
	const { root, state, path } = await fixture(context);
	await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "--eval", 'import { createJiti } from "jiti"; await createJiti(import.meta.url, { moduleCache: false }).import(process.argv[1]);', fileURLToPath(new URL("./fixtures/file-lock-worker.ts", import.meta.url)), root, "state", `${index}`], { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", chunk => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", code => code === 0 ? resolve() : reject(new Error(stderr)));
	})));
	const database = new DatabaseSync(path);
	try { assert.equal(database.prepare("SELECT COUNT(*) AS count FROM state").get()?.count, 48); }
	finally { database.close(); }
	assert.equal(await state.getOptional({ id: "missing", schema: Type.String({ default: "not invented" }) }), undefined);
	await assert.rejects(state.get({ id: "missing", schema: Type.String() }), /Missing shared state/);
});

test("state validates stored values and rejected writes do not poison subsequent operations", async context => {
	const { state, path } = await fixture(context);
	const field = { id: "count", schema: Type.Integer() };
	await assert.rejects(state.set(field, 1.5));
	await state.set(field, 2);
	assert.equal(await state.get(field), 2);
	const database = new DatabaseSync(path);
	try { database.prepare("UPDATE state SET value = ? WHERE key = ?").run("[]", field.id); }
	finally { database.close(); }
	await assert.rejects(state.get(field));
	await state.set(field, 3);
	assert.equal(await state.get(field), 3);
	const ordinary = { id: "__proto__", schema: Type.String() };
	await state.set(ordinary, "ordinary field");
	assert.equal(await state.get(ordinary), "ordinary field");
});

test("workflow and tool writes use the same SQLite-backed state", async context => {
	const { state, path } = await fixture(context);
	const other = await SharedState.open({ path, create: false });
	context.onTestFinished(() => other.close());
	const field = { id: "count", schema: Type.Number() };
	const tools = createStateTools({ state: other, fields: [{ field, access: "write" }] });
	const write = tools.find(tool => tool.name === "norn_state_set")!;
	await state.set(field, 1);
	await write.execute("write", { key: field.id, value: 2 }, undefined, undefined, {} as never);
	assert.equal(await state.get(field), 2);
});

test("state tools delegate to a supplied interface and respect cancellation", async context => {
	const { state: stored } = await fixture(context);
	const state: SharedStateAccess = { get: stored.get.bind(stored), getOptional: stored.getOptional.bind(stored), set: stored.set.bind(stored) };
	const field = { id: "message", schema: Type.String() };
	const tools = createStateTools({ state, fields: [{ field, access: "read-write" }] });
	const set = tools.find(tool => tool.name === "norn_state_set")!;
	const get = tools.find(tool => tool.name === "norn_state_get")!;
	await set.execute("write", { key: field.id, value: "saved" }, undefined, undefined, {} as never);
	const result = await get.execute("read", { key: field.id, offset: 0, limit: 10000 }, undefined, undefined, {} as never);
	assert.deepEqual(JSON.parse((result.details as { text: string }).text), { isSet: true, value: "saved" });
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(set.execute("cancelled", { key: field.id, value: "cancelled" }, controller.signal, undefined, {} as never));
	assert.equal(await state.get(field), "saved");
});

test("checkpoint rollback restores a closed workspace database", async context => {
	const { root, state, path } = await fixture(context);
	const store = await NornRunStore.initialize(root);
	const field = { id: "phase", schema: Type.String() };
	await state.set(field, "before");
	state.close();
	const checkpoint = await store.snapshotCurrent("saved");
	const later = await SharedState.open({ path, create: false });
	try { await later.set(field, "after"); }
	finally { later.close(); }
	await store.restoreSnapshot(checkpoint.id, undefined);
	const reopened = await SharedState.open({ path, create: false });
	try { assert.equal(await reopened.get(field), "before"); }
	finally { reopened.close(); }
});

test("state tools scope access, validate schemas and paginate large values", async context => {
	const { state } = await fixture(context);
	const visible = { id: "visible", schema: Type.String() };
	const hidden = { id: "hidden", schema: Type.String() };
	await state.set(hidden, "secret context");
	await state.set(visible, "a".repeat(20000));
	const tools = createStateTools({ state, fields: [{ field: visible, access: "read" }] });
	const execute = async (name: string, args: object) => tools.find(tool => tool.name === name)!.execute("call", args, undefined, undefined, {} as never);
	const listed = await execute("norn_state_list", { offset: 0, limit: 10000 });
	assert.ok(JSON.stringify(listed.content).includes("visible"));
	assert.ok(!JSON.stringify(listed.content).includes("hidden"));
	await assert.rejects(execute("norn_state_get", { key: "hidden", offset: 0, limit: 10000 }), /not attached/);
	await assert.rejects(execute("norn_state_set", { key: "visible", value: "changed" }), /not attached/);
	const first = await execute("norn_state_get", { key: "visible", offset: 0, limit: 10000 });
	const details = first.details as { nextOffset: number; revision: string; text: string };
	assert.equal(details.nextOffset, 10000);
	assert.ok(Buffer.byteLength(JSON.stringify(first.content)) < 50000);
	const writerTools = createStateTools({ state, fields: [{ field: visible, access: "write" }] });
	await assert.rejects(writerTools.find(tool => tool.name === "norn_state_set")!.execute("call", { key: "visible", value: 3 }, undefined, undefined, {} as never));
	assert.equal((await state.get(visible)).length, 20000);
});

test("state creation preserves values and opening missing or corrupt storage fails", async context => {
	const { state, path } = await fixture(context);
	const field = { id: "saved", schema: Type.String() };
	await state.set(field, "retained");
	state.close();
	const reopened = await SharedState.open({ path, create: true });
	assert.equal(await reopened.get(field), "retained");
	reopened.close();
	await rm(path);
	await assert.rejects(SharedState.open({ path, create: false }), { code: "ENOENT" });
	await writeFile(path, "invalid database");
	await assert.rejects(SharedState.open({ path, create: false }));
	assert.equal(await readFile(path, "utf8"), "invalid database");
});

test("workflows reopen their own workspace state across transitions and gate resume", async context => {
	const { root, state } = await fixture(context);
	state.close();
	const scope = workflowScope({ id: "storedState" });
	const field = { id: "value", schema: Type.Number() };
	const start = scope.workflow({
		id: "start", isEntrypoint: true, instructions: "Persist a value before a gate.", args: Type.Object({}),
		async execute({ paths }) {
			const store = await SharedState.open({ path: join(paths.workspace, "state.sqlite"), create: true });
			try { await store.set(field, 7); return finish({ decision: "reject" }); }
			finally { store.close(); }
		},
	});
	const finish = scope.workflow({
		id: "finish", isEntrypoint: false, args: Type.Object({ decision: Type.Enum(["accept", "reject"]) }),
		gate: { enabled: true, fields: ["decision"], describe: () => "Accept the persisted value." },
		async execute({ paths, run }) {
			const store = await SharedState.open({ path: join(paths.workspace, "state.sqlite"), create: false });
			try { return run.complete({ data: { value: await store.get(field) } }); }
			finally { store.close(); }
		},
	});
	const engine = new NornEngine({ cwd: root, gateMode: "pause" });
	engine.registerWorkflows([start, finish]);
	const interrupted = await engine.runWorkflow(start, {}, undefined);
	assert.equal(interrupted.status, "interrupted");
	const resumed = new NornEngine({ cwd: root, gateMode: "pause" });
	resumed.registerWorkflows([start, finish]);
	const completed = await resumed.resumeWorkflow(join(root, ".norn", "runs", interrupted.id), { decision: "accept" });
	assert.equal(completed.status, "completed");
	assert.deepEqual(completed.metadata?.data, { value: 7 });
});

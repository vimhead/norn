import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, test, vi, type TestContext } from "vitest";
import { NornRunStore } from "../packages/cli/src/internal/run-store.ts";
import { z } from "zod";

type FileSystemFault = { operation: "writeFile" | "rename"; matches: (...args: unknown[]) => boolean; triggered: boolean };
let activeFault: FileSystemFault | undefined;

function throwInjectedFault(operation: FileSystemFault["operation"], args: unknown[]): void {
	if (activeFault?.operation !== operation || !activeFault.matches(...args)) return;
	activeFault.triggered = true;
	throw Object.assign(new Error(`Injected ${operation} failure`), { code: "EIO" });
}

const originalWriteFile = fs.writeFile;
vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
	throwInjectedFault("writeFile", args);
	return originalWriteFile(...args);
});
const originalRename = fs.rename;
vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
	throwInjectedFault("rename", args);
	return originalRename(...args);
});
syncBuiltinESMExports();
afterAll(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });

async function createFixture(context: TestContext) {
	const root = await fs.mkdtemp(join(tmpdir(), "norn-store-test-"));
	context.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
	const store = await NornRunStore.initialize(root);
	const evidencePath = join(root, "current/evidence.txt");
	await fs.writeFile(evidencePath, "original");
	const first = await store.snapshotCurrent("first");
	await fs.writeFile(evidencePath, "second");
	const second = await store.snapshotCurrent("second");
	await fs.writeFile(evidencePath, "dirty evidence must survive failure");
	const history = await fs.readFile(join(root, "current/checkpoints.json"), "utf8");
	return { root, store, evidencePath, first, second, history };
}

async function assertCurrentUnchanged(fixture: Awaited<ReturnType<typeof createFixture>>) {
	assert.equal(await fs.readFile(fixture.evidencePath, "utf8"), "dirty evidence must survive failure");
	assert.equal(await fs.readFile(join(fixture.root, "current/checkpoints.json"), "utf8"), fixture.history);
	assert.equal(await fixture.store.currentSnapshotRef(), fixture.second.id);
	assert.equal((await fs.readdir(fixture.root)).some(name => /^\.(restore|previous)-/.test(name)), false);
}

function failOperation(context: TestContext, operation: FileSystemFault["operation"], matches: FileSystemFault["matches"]) {
	const fault: FileSystemFault = { operation, matches, triggered: false };
	activeFault = fault;
	context.onTestFinished(() => { activeFault = undefined; });
	return () => assert.equal(fault.triggered, true, "the intended filesystem fault was exercised");
}

const snapshotSchema = z.looseObject({ entries: z.array(z.looseObject({ path: z.string(), type: z.string(), sha256: z.string().optional() })) });

for (const corruption of ["missing", "invalid gzip", "checksum mismatch"]) {
	test(`${corruption} snapshot object leaves current files, history and ref intact`, async context => {
		const fixture = await createFixture(context);
		const snapshot = snapshotSchema.parse(JSON.parse(await fs.readFile(join(fixture.root, fixture.first.path), "utf8")));
		const entry = snapshot.entries.find(entry => entry.path === "evidence.txt");
		assert.ok(entry?.sha256);
		const objectPath = join(fixture.root, "store/objects/sha256", entry.sha256.slice(0, 2), entry.sha256.slice(2, 4), `${entry.sha256}.gz`);
		if (corruption === "missing") await fs.rm(objectPath);
		else await fs.writeFile(objectPath, corruption === "invalid gzip" ? "broken gzip" : gzipSync("wrong contents"));
		await assert.rejects(fixture.store.restoreSnapshot(fixture.first.id, undefined), corruption === "checksum mismatch" ? /checksum mismatch/ : Error);
		await assertCurrentUnchanged(fixture);
	});
}

for (const fault of ["materialization", "checkout swap", "ref publication"]) {
	test(`failed restore ${fault} preserves the previous checkout`, async context => {
		const fixture = await createFixture(context);
		const assertTriggered = fault === "materialization"
			? failOperation(context, "writeFile", path => String(path).includes(`${sep}.restore-`) && String(path).endsWith("evidence.txt"))
			: failOperation(context, "rename", (source, destination) => fault === "checkout swap"
				? String(source).includes(`${sep}.restore-`) && destination === join(fixture.root, "current")
				: destination === join(fixture.root, "store/refs/current"));
		await assert.rejects(fixture.store.restoreSnapshot(fixture.first.id, undefined), /Injected/);
		assertTriggered();
		await assertCurrentUnchanged(fixture);
	});
}

for (const fault of ["object storage", "manifest publication", "history publication", "ref publication"]) {
	test(`failed checkpoint ${fault} cannot advertise a new active checkpoint`, async context => {
		const fixture = await createFixture(context);
		const assertTriggered = failOperation(context, "rename", (_source, destination) => {
			if (fault === "object storage") return String(destination).includes(`${sep}objects${sep}`);
			if (fault === "manifest publication") return String(destination).includes(`${sep}snapshots${sep}`);
			if (fault === "history publication") return destination === join(fixture.root, "current/checkpoints.json");
			return destination === join(fixture.root, "store/refs/current");
		});
		await assert.rejects(fixture.store.snapshotCurrent("must not be published"), /Injected/);
		assertTriggered();
		await assertCurrentUnchanged(fixture);
	});
}

test("failed first snapshot leaves no checkpoint history or current ref", async context => {
	const root = await fs.mkdtemp(join(tmpdir(), "norn-first-snapshot-test-"));
	context.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
	const store = await NornRunStore.initialize(root);
	const assertTriggered = failOperation(context, "rename", (_source, destination) => destination === join(root, "store/refs/current"));
	await assert.rejects(store.snapshotCurrent("first"), /Injected/);
	assertTriggered();
	assert.deepEqual(await store.listCheckpoints(), []);
	await assert.rejects(fs.access(join(root, "current/checkpoints.json")), { code: "ENOENT" });
	await assert.rejects(store.currentSnapshotRef(), { code: "ENOENT" });
});

test("successful restore rewinds checkpoint history with the files", async context => {
	const fixture = await createFixture(context);
	await fixture.store.restoreSnapshot(fixture.first.id, undefined);
	assert.equal(await fs.readFile(fixture.evidencePath, "utf8"), "original");
	assert.deepEqual(await fixture.store.listCheckpoints(), [fixture.first]);
	assert.equal(await fixture.store.currentSnapshotRef(), fixture.first.id);
	await assert.rejects(fixture.store.restoreSnapshot(fixture.second.id, undefined), /Unknown active run checkpoint/);
	await fs.writeFile(fixture.evidencePath, "new dirt");
	await fixture.store.restoreCurrentSnapshot();
	assert.equal(await fs.readFile(fixture.evidencePath, "utf8"), "original");
});

test("resume preparation errors happen before replacing current", async context => {
	const fixture = await createFixture(context);
	await assert.rejects(fixture.store.restoreSnapshot(fixture.first.id, async stagedRoot => {
		await fs.writeFile(join(stagedRoot, "current/evidence.txt"), "staged change");
		throw new Error("Cannot resume this checkpoint");
	}), /Cannot resume/);
	await assertCurrentUnchanged(fixture);
});

test("snapshot symlink parents cannot redirect materialization outside staging", { skip: process.platform === "win32" }, async context => {
	const fixture = await createFixture(context);
	const external = join(fixture.root, "external");
	await fs.mkdir(external);
	const snapshotPath = join(fixture.root, fixture.first.path);
	const snapshot = snapshotSchema.parse(JSON.parse(await fs.readFile(snapshotPath, "utf8")));
	const file = snapshot.entries.find(entry => entry.path === "evidence.txt");
	assert.ok(file);
	snapshot.entries.push({ path: "link", type: "symlink", target: external }, { ...file, path: "link/escaped.txt" });
	await fs.writeFile(snapshotPath, JSON.stringify(snapshot));
	await assert.rejects(fixture.store.restoreSnapshot(fixture.first.id, undefined), /parent is not a directory/);
	await assert.rejects(fs.access(join(external, "escaped.txt")), { code: "ENOENT" });
	await assertCurrentUnchanged(fixture);
});

test("ordinary directories, file modes and symlinks still restore", { skip: process.platform === "win32" }, async context => {
	const fixture = await createFixture(context);
	const directory = join(fixture.root, "current/nested");
	await fs.mkdir(directory);
	await fs.writeFile(join(directory, "script"), "executable");
	await fs.chmod(join(directory, "script"), 0o755);
	await fs.symlink("nested/script", join(fixture.root, "current/link"));
	await fs.chmod(directory, 0o555);
	const checkpoint = await fixture.store.snapshotCurrent("read-only directory");
	await fs.chmod(directory, 0o755);
	await fs.rm(directory, { recursive: true });
	await fixture.store.restoreSnapshot(checkpoint.id, undefined);
	assert.equal(await fs.readFile(join(fixture.root, "current/link"), "utf8"), "executable");
	assert.equal((await fs.stat(directory)).mode & 0o777, 0o555);
	assert.equal((await fs.stat(join(directory, "script"))).mode & 0o777, 0o755);
	await fs.chmod(directory, 0o755);
});

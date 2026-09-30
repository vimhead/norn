import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterAll, test, vi, type TestContext } from "vitest";
import { NornRunStore } from "../packages/cli/src/internal/run-store.ts";

type FileSystemFault = {
	operation: "writeFile" | "rename" | "rm";
	matches: (...args: unknown[]) => boolean;
	triggered: boolean;
};
let activeFault: FileSystemFault | undefined;

function throwInjectedFault(
	operation: FileSystemFault["operation"],
	args: unknown[],
): void {
	if (activeFault?.operation !== operation || !activeFault.matches(...args))
		return;
	activeFault.triggered = true;
	throw Object.assign(new Error(`Injected ${operation} failure`), {
		code: "EIO",
	});
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
const originalRm = fs.rm;
vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
	throwInjectedFault("rm", args);
	return originalRm(...args);
});
syncBuiltinESMExports();
afterAll(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
});

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
	const history = await fs.readFile(
		join(root, "current/checkpoints.json"),
		"utf8",
	);
	return { root, store, evidencePath, first, second, history };
}

async function assertCurrentUnchanged(
	fixture: Awaited<ReturnType<typeof createFixture>>,
) {
	assert.equal(
		await fs.readFile(fixture.evidencePath, "utf8"),
		"dirty evidence must survive failure",
	);
	assert.equal(
		await fs.readFile(join(fixture.root, "current/checkpoints.json"), "utf8"),
		fixture.history,
	);
	assert.equal(await fixture.store.currentSnapshotRef(), fixture.second.id);
	assert.equal(
		(await fs.readdir(fixture.root)).some((name) =>
			/^\.(restore|previous)-/.test(name),
		),
		false,
	);
}

function failOperation(
	context: TestContext,
	operation: FileSystemFault["operation"],
	matches: FileSystemFault["matches"],
) {
	const fault: FileSystemFault = { operation, matches, triggered: false };
	activeFault = fault;
	context.onTestFinished(() => {
		activeFault = undefined;
	});
	return () =>
		assert.equal(
			fault.triggered,
			true,
			"the intended filesystem fault was exercised",
		);
}

const snapshotSchema = Type.Object(
	{
		entries: Type.Array(
			Type.Object(
				{
					path: Type.String(),
					type: Type.String(),
					sha256: Type.Optional(Type.String()),
					target: Type.Optional(Type.String()),
				},
				{ additionalProperties: true },
			),
		),
	},
	{ additionalProperties: true },
);

for (const corruption of ["missing", "invalid gzip", "checksum mismatch"]) {
	test(`${corruption} snapshot object leaves current files, history and ref intact`, async (context) => {
		const fixture = await createFixture(context);
		const snapshot = Value.Parse(
			snapshotSchema,
			JSON.parse(
				gunzipSync(
					await fs.readFile(join(fixture.root, fixture.first.path)),
				).toString("utf8"),
			),
		);
		const entry = snapshot.entries.find(
			(entry) => entry.path === "evidence.txt",
		);
		assert.ok(entry?.sha256);
		const objectPath = join(
			fixture.root,
			"store/objects/sha256",
			entry.sha256.slice(0, 2),
			entry.sha256.slice(2, 4),
			`${entry.sha256}.gz`,
		);
		if (corruption === "missing") await fs.rm(objectPath);
		else
			await fs.writeFile(
				objectPath,
				corruption === "invalid gzip"
					? "broken gzip"
					: gzipSync("wrong contents"),
			);
		await assert.rejects(
			fixture.store.restoreSnapshot(fixture.first.id, undefined),
			corruption === "checksum mismatch" ? /checksum mismatch/ : Error,
		);
		await assertCurrentUnchanged(fixture);
	});
}

for (const fault of ["materialization", "checkout swap", "ref publication"]) {
	test(`failed restore ${fault} preserves the previous checkout`, async (context) => {
		const fixture = await createFixture(context);
		const assertTriggered =
			fault === "materialization"
				? failOperation(
						context,
						"writeFile",
						(path) =>
							String(path).includes(`${sep}.restore-`) &&
							String(path).endsWith("evidence.txt"),
					)
				: failOperation(context, "rename", (source, destination) =>
						fault === "checkout swap"
							? String(source).includes(`${sep}.restore-`) &&
								destination === join(fixture.root, "current")
							: destination === join(fixture.root, "store/refs/current"),
					);
		await assert.rejects(
			fixture.store.restoreSnapshot(fixture.first.id, undefined),
			/Injected/,
		);
		assertTriggered();
		await assertCurrentUnchanged(fixture);
	});
}

for (const fault of [
	"object storage",
	"manifest publication",
	"history publication",
	"ref publication",
]) {
	test(`failed checkpoint ${fault} cannot advertise a new active checkpoint`, async (context) => {
		const fixture = await createFixture(context);
		const assertTriggered = failOperation(
			context,
			"rename",
			(_source, destination) => {
				if (fault === "object storage")
					return String(destination).includes(`${sep}objects${sep}`);
				if (fault === "manifest publication")
					return String(destination).includes(`${sep}snapshots${sep}`);
				if (fault === "history publication")
					return destination === join(fixture.root, "current/checkpoints.json");
				return destination === join(fixture.root, "store/refs/current");
			},
		);
		await assert.rejects(
			fixture.store.snapshotCurrent("must not be published"),
			/Injected/,
		);
		assertTriggered();
		await assertCurrentUnchanged(fixture);
	});
}

test("failed first snapshot leaves no checkpoint history or current ref", async (context) => {
	const root = await fs.mkdtemp(join(tmpdir(), "norn-first-snapshot-test-"));
	context.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
	const store = await NornRunStore.initialize(root);
	const assertTriggered = failOperation(
		context,
		"rename",
		(_source, destination) => destination === join(root, "store/refs/current"),
	);
	await assert.rejects(store.snapshotCurrent("first"), /Injected/);
	assertTriggered();
	assert.deepEqual(await store.listCheckpoints(), []);
	await assert.rejects(fs.access(join(root, "current/checkpoints.json")), {
		code: "ENOENT",
	});
	await assert.rejects(store.currentSnapshotRef(), { code: "ENOENT" });
});

test("successful restore rewinds checkpoint history with the files", async (context) => {
	const fixture = await createFixture(context);
	await fixture.store.restoreSnapshot(fixture.first.id, undefined);
	assert.equal(await fs.readFile(fixture.evidencePath, "utf8"), "original");
	assert.deepEqual(await fixture.store.listCheckpoints(), [fixture.first]);
	assert.equal(await fixture.store.currentSnapshotRef(), fixture.first.id);
	await assert.rejects(
		fixture.store.restoreSnapshot(fixture.second.id, undefined),
		/Unknown active run checkpoint/,
	);
	await fs.writeFile(fixture.evidencePath, "new dirt");
	await fixture.store.restoreCurrentSnapshot();
	assert.equal(await fs.readFile(fixture.evidencePath, "utf8"), "original");
});

test("new manifests are compressed and remain usable after reopening the store", async (context) => {
	const fixture = await createFixture(context);
	assert.equal(
		fixture.first.path,
		join("store", "snapshots", `${fixture.first.id}.json.gz`),
	);
	const compressed = await fs.readFile(join(fixture.root, fixture.first.path));
	const decompressed = gunzipSync(compressed);
	assert.ok(compressed.length < decompressed.length);
	assert.equal(JSON.parse(decompressed.toString("utf8")).id, fixture.first.id);
	const reopened = await NornRunStore.open(fixture.root);
	assert.deepEqual(await reopened.listCheckpoints(), [
		fixture.first,
		fixture.second,
	]);
	await reopened.restoreCurrentSnapshot();
	assert.equal(await fs.readFile(fixture.evidencePath, "utf8"), "second");
});

for (const corruption of [
	"missing",
	"invalid gzip",
	"truncated gzip",
	"invalid JSON",
]) {
	test(`${corruption} snapshot manifest leaves current files, history and ref intact`, async (context) => {
		const fixture = await createFixture(context);
		const path = join(fixture.root, fixture.first.path);
		if (corruption === "missing") await fs.rm(path);
		else if (corruption === "truncated gzip") {
			const compressed = await fs.readFile(path);
			await fs.writeFile(path, compressed.subarray(0, compressed.length - 8));
		} else {
			await fs.writeFile(
				path,
				corruption === "invalid gzip"
					? "broken gzip"
					: gzipSync("invalid JSON"),
			);
		}
		await assert.rejects(
			fixture.store.restoreSnapshot(fixture.first.id, undefined),
		);
		await assertCurrentUnchanged(fixture);
	});
}

test("corrupt compressed manifest does not fall back to an uncompressed sibling", async (context) => {
	const fixture = await createFixture(context);
	const path = join(fixture.root, fixture.first.path);
	await fs.writeFile(path.slice(0, -3), gunzipSync(await fs.readFile(path)));
	await fs.writeFile(path, "broken gzip");
	await assert.rejects(
		fixture.store.restoreSnapshot(fixture.first.id, undefined),
	);
	await assertCurrentUnchanged(fixture);
});

test("failed compressed manifest write cleans staging without publishing a checkpoint", async (context) => {
	const fixture = await createFixture(context);
	const previousFiles = await fs.readdir(join(fixture.root, "store/snapshots"));
	const assertTriggered = failOperation(context, "writeFile", (path) =>
		String(path).includes(`${sep}snapshots${sep}`),
	);
	await assert.rejects(
		fixture.store.snapshotCurrent("cannot write manifest"),
		/Injected/,
	);
	assertTriggered();
	assert.deepEqual(
		await fs.readdir(join(fixture.root, "store/snapshots")),
		previousFiles,
	);
	await assertCurrentUnchanged(fixture);
});

async function createLegacyFixture(context: TestContext) {
	const root = await fs.mkdtemp(join(tmpdir(), "norn-legacy-store-test-"));
	context.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
	await NornRunStore.initialize(root);
	const checkpoint = {
		id: "cp_legacy",
		path: join("store", "snapshots", "cp_legacy.json"),
		index: 1,
		message: "legacy checkpoint",
		createdAt: "2026-01-01T00:00:00.000Z",
	};
	const files = [
		{ path: "evidence.txt", content: "legacy evidence" },
		{
			path: "checkpoints.json",
			content: `${JSON.stringify([checkpoint], null, 2)}\n`,
		},
	];
	const entries = [];
	for (const file of files) {
		const bytes = Buffer.from(file.content);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const directory = join(
			root,
			"store/objects/sha256",
			sha256.slice(0, 2),
			sha256.slice(2, 4),
		);
		await fs.mkdir(directory, { recursive: true });
		await fs.writeFile(join(directory, `${sha256}.gz`), gzipSync(bytes));
		await fs.writeFile(join(root, "current", file.path), bytes);
		entries.push({
			path: file.path,
			type: "file",
			sha256,
			size: bytes.length,
			mode: 0o100644,
			mtimeMs: Date.parse(checkpoint.createdAt),
			compression: "gzip",
		});
	}
	await fs.writeFile(
		join(root, checkpoint.path),
		JSON.stringify({ version: 1, ...checkpoint, entries }, null, 2),
	);
	await fs.writeFile(join(root, "store/refs/current"), `${checkpoint.id}\n`);
	return { root, checkpoint, evidencePath: join(root, "current/evidence.txt") };
}

test("legacy checkpoints remain restorable alongside new compressed checkpoints", async (context) => {
	const fixture = await createLegacyFixture(context);
	const legacyBytes = await fs.readFile(
		join(fixture.root, fixture.checkpoint.path),
	);
	const store = await NornRunStore.open(fixture.root);
	assert.deepEqual(await store.listCheckpoints(), [fixture.checkpoint]);
	await fs.writeFile(fixture.evidencePath, "dirty legacy evidence");
	await store.restoreCurrentSnapshot();
	assert.equal(
		await fs.readFile(fixture.evidencePath, "utf8"),
		"legacy evidence",
	);
	await fs.writeFile(fixture.evidencePath, "new evidence");
	const compressed = await store.snapshotCurrent("compressed checkpoint");
	assert.ok(compressed.path.endsWith(".json.gz"));
	await fs.writeFile(fixture.evidencePath, "dirty new evidence");
	const reopened = await NornRunStore.open(fixture.root);
	await reopened.restoreSnapshot(compressed.id, undefined);
	assert.equal(await fs.readFile(fixture.evidencePath, "utf8"), "new evidence");
	assert.deepEqual(await reopened.listCheckpoints(), [
		fixture.checkpoint,
		compressed,
	]);
	await reopened.restoreSnapshot(fixture.checkpoint.id, undefined);
	assert.equal(
		await fs.readFile(fixture.evidencePath, "utf8"),
		"legacy evidence",
	);
	assert.deepEqual(await reopened.listCheckpoints(), [fixture.checkpoint]);
	assert.equal(await reopened.currentSnapshotRef(), fixture.checkpoint.id);
	assert.deepEqual(
		await fs.readFile(join(fixture.root, fixture.checkpoint.path)),
		legacyBytes,
	);
});

test("failed prune marker publication leaves checkpoint history restorable", async (context) => {
	const fixture = await createFixture(context);
	const assertTriggered = failOperation(
		context,
		"rename",
		(_source, destination) =>
			destination === join(fixture.root, "checkpoint-history-pruned.json"),
	);
	await assert.rejects(
		fixture.store.pruneCheckpointHistory("2026-01-01T00:00:00.000Z"),
		/Injected/,
	);
	assertTriggered();
	await assertCurrentUnchanged(fixture);
	assert.deepEqual(await fixture.store.listCheckpoints(), [
		fixture.first,
		fixture.second,
	]);
	await fixture.store.restoreSnapshot(fixture.first.id, undefined);
	assert.equal(await fs.readFile(fixture.evidencePath, "utf8"), "original");
});

for (const fault of ["history publication", "store deletion"]) {
	test(`interrupted prune ${fault} cannot advertise partially deleted history and is retryable`, async (context) => {
		const fixture = await createFixture(context);
		const assertTriggered =
			fault === "history publication"
				? failOperation(
						context,
						"rename",
						(_source, destination) =>
							destination === join(fixture.root, "current/checkpoints.json"),
					)
				: failOperation(
						context,
						"rm",
						(path) => path === join(fixture.root, "store"),
					);
		await assert.rejects(
			fixture.store.pruneCheckpointHistory("2026-01-01T00:00:00.000Z"),
			/Injected/,
		);
		assertTriggered();
		assert.equal(
			await fs.readFile(fixture.evidencePath, "utf8"),
			"dirty evidence must survive failure",
		);
		const reopened = await NornRunStore.open(fixture.root);
		assert.deepEqual(await reopened.listCheckpoints(), []);
		await assert.rejects(
			reopened.restoreSnapshot(fixture.first.id, undefined),
			/history was pruned/,
		);
		activeFault = undefined;
		await reopened.pruneCheckpointHistory("2026-01-02T00:00:00.000Z");
		await assert.rejects(fs.access(join(fixture.root, "store")), {
			code: "ENOENT",
		});
		assert.equal(
			JSON.parse(
				await fs.readFile(
					join(fixture.root, "checkpoint-history-pruned.json"),
					"utf8",
				),
			).prunedAt,
			"2026-01-01T00:00:00.000Z",
		);
		assert.deepEqual(
			JSON.parse(
				await fs.readFile(
					join(fixture.root, "current/checkpoints.json"),
					"utf8",
				),
			),
			[],
		);
	});
}

test("invalid pruning markers block access instead of silently disabling recovery", async (context) => {
	const fixture = await createFixture(context);
	await fs.writeFile(
		join(fixture.root, "checkpoint-history-pruned.json"),
		JSON.stringify({ version: 1, prunedAt: "invalid" }),
	);
	await assert.rejects(NornRunStore.open(fixture.root), /Invalid pruned/);
	await assert.rejects(fixture.store.listCheckpoints(), /Invalid pruned/);
	await fs.rm(join(fixture.root, "checkpoint-history-pruned.json"));
	await assertCurrentUnchanged(fixture);
});

test("resume preparation errors happen before replacing current", async (context) => {
	const fixture = await createFixture(context);
	await assert.rejects(
		fixture.store.restoreSnapshot(fixture.first.id, async (stagedRoot) => {
			await fs.writeFile(
				join(stagedRoot, "current/evidence.txt"),
				"staged change",
			);
			throw new Error("Cannot resume this checkpoint");
		}),
		/Cannot resume/,
	);
	await assertCurrentUnchanged(fixture);
});

test(
	"snapshot symlink parents cannot redirect materialization outside staging",
	{ skip: process.platform === "win32" },
	async (context) => {
		const fixture = await createFixture(context);
		const external = join(fixture.root, "external");
		await fs.mkdir(external);
		const snapshotPath = join(fixture.root, fixture.first.path);
		const snapshot = Value.Parse(
			snapshotSchema,
			JSON.parse(gunzipSync(await fs.readFile(snapshotPath)).toString("utf8")),
		);
		const file = snapshot.entries.find(
			(entry) => entry.path === "evidence.txt",
		);
		assert.ok(file);
		snapshot.entries.push(
			{ path: "link", type: "symlink", target: external },
			{ ...file, path: "link/escaped.txt" },
		);
		await fs.writeFile(snapshotPath, gzipSync(JSON.stringify(snapshot)));
		await assert.rejects(
			fixture.store.restoreSnapshot(fixture.first.id, undefined),
			/parent is not a directory/,
		);
		await assert.rejects(fs.access(join(external, "escaped.txt")), {
			code: "ENOENT",
		});
		await assertCurrentUnchanged(fixture);
	},
);

test(
	"ordinary directories, file modes and symlinks still restore",
	{ skip: process.platform === "win32" },
	async (context) => {
		const fixture = await createFixture(context);
		const directory = join(fixture.root, "current/nested");
		await fs.mkdir(directory);
		await fs.writeFile(join(directory, "script"), "executable");
		await fs.chmod(join(directory, "script"), 0o755);
		await fs.symlink("nested/script", join(fixture.root, "current/link"));
		await fs.chmod(directory, 0o555);
		const checkpoint = await fixture.store.snapshotCurrent(
			"read-only directory",
		);
		await fs.chmod(directory, 0o755);
		await fs.rm(directory, { recursive: true });
		await fixture.store.restoreSnapshot(checkpoint.id, undefined);
		assert.equal(
			await fs.readFile(join(fixture.root, "current/link"), "utf8"),
			"executable",
		);
		assert.equal((await fs.stat(directory)).mode & 0o777, 0o555);
		assert.equal(
			(await fs.stat(join(directory, "script"))).mode & 0o777,
			0o755,
		);
		await fs.chmod(directory, 0o755);
	},
);

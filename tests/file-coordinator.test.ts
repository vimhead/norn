import {
	NornFileCoordinator,
	createRunFileCoordinator,
} from "../packages/cli/src/internal/file-coordinator.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "vitest";
import { NornRunLogger } from "../packages/cli/src/internal/run-log.ts";
import { NornRunStateStore } from "../packages/cli/src/internal/run-state.ts";

async function fixture(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "norn-file-coordinator-"));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "current"));
	await writeFile(join(root, "counter.json"), "0");
	return {
		root,
		files: createRunFileCoordinator(root),
		target: join(root, "counter.json"),
	};
}

function worker(root: string, mode: string, name: string) {
	const child = spawn(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			'import { createJiti } from "jiti"; await createJiti(import.meta.url, { moduleCache: false }).import(process.argv[1]);',
			fileURLToPath(new URL("./fixtures/file-lock-worker.ts", import.meta.url)),
			root,
			mode,
			name,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const completed = new Promise<void>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code, signal) =>
			code === 0 || signal === "SIGKILL"
				? resolve()
				: reject(new Error(stderr || `Worker exited: ${code}`)),
		);
	});
	return { child, completed };
}

test(
	"independent processes serialize whole mutations and recover a dead owner with competing waiters",
	{ timeout: 15000 },
	async (context) => {
		const { root, target } = await fixture(context);
		const holder = worker(root, "hold", "holder");
		context.onTestFinished(async () => {
			holder.child.kill("SIGKILL");
			await holder.completed;
		});
		await Promise.race([
			new Promise<void>((resolve) =>
				holder.child.stdout.once("data", () => resolve()),
			),
			holder.completed.then(() => {
				throw new Error("Holder exited before acquiring");
			}),
		]);
		const shortWait = new NornFileCoordinator({
			lockRoot: join(root, "locks"),
			waitTimeoutMs: 40,
		});
		await assert.rejects(shortWait.readText(target), /Timed out/);
		holder.child.kill("SIGKILL");
		await holder.completed;
		await Promise.all(
			Array.from(
				{ length: 4 },
				(_, index) => worker(root, "counter", `${index}`).completed,
			),
		);
		assert.equal(JSON.parse(await readFile(target, "utf8")), 48);
		assert.deepEqual(await readdir(join(root, "locks")), []);
	},
);

test("locks coordinate canonical aliases, release after exceptions, and do not block unrelated files", async (context) => {
	const { root, files, target } = await fixture(context);
	const alias = join(root, "alias.json");
	await symlink(target, alias);
	await assert.rejects(
		files.withExclusiveLock(alias, async (path) => {
			assert.equal(path, await realpath(target));
			await files.writeText(join(root, "unrelated.json"), "other");
			const competing = new NornFileCoordinator({
				lockRoot: join(root, "locks"),
				waitTimeoutMs: 30,
			});
			await assert.rejects(competing.readText(target), /Timed out/);
			throw new Error("operation failed");
		}),
		/operation failed/,
	);
	await files.writeText(alias, "1");
	assert.equal(await files.readText(target), "1");
});

test("malformed ownership fails closed", async (context) => {
	const { root, files, target } = await fixture(context);
	await files.withExclusiveLock(target, async () => {
		const [directory] = (await readdir(join(root, "locks"))).filter((name) =>
			name.endsWith(".lock"),
		);
		const [marker] = await readdir(join(root, "locks", directory));
		await writeFile(join(root, "locks", directory, marker), "{}");
		await assert.rejects(files.readText(target));
	});
});

test("independent logger handles append without losing events", async (context) => {
	const { root, files } = await fixture(context);
	const manifestPath = join(root, "current", "manifest.json");
	const first = new NornRunLogger({
		manifestPath,
		files,
		manifest: {
			id: "test",
			name: "test",
			workflowId: "test.step",
			runRoot: root,
			workspace: root,
			initialCwd: root,
			startedAt: new Date().toISOString(),
		},
	});
	await first.record({ type: "initial" });
	const second = await NornRunLogger.load(
		manifestPath,
		createRunFileCoordinator(root),
	);
	await Promise.all(
		Array.from({ length: 30 }, (_, index) =>
			(index % 2 ? first : second).record({ type: "event", index }),
		),
	);
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	assert.equal(manifest.events.length, 31);
	assert.equal(
		new Set(
			manifest.events.slice(1).map((event: { index: number }) => event.index),
		).size,
		30,
	);
});

test("lock cleanup preserves both an operation error and lost ownership evidence", async (context) => {
	const { root, files, target } = await fixture(context);
	await assert.rejects(
		files.withExclusiveLock(target, async () => {
			const [directory] = (await readdir(join(root, "locks"))).filter((name) =>
				name.endsWith(".lock"),
			);
			await rm(join(root, "locks", directory), { recursive: true });
			throw new Error("original failure");
		}),
		(error) => {
			assert.ok(error instanceof AggregateError);
			assert.equal(error.errors.length, 2);
			assert.equal(error.errors[0].message, "original failure");
			assert.equal(error.errors[1].code, "ENOENT");
			return true;
		},
	);
	assert.equal(await files.readText(target), "0");
});

test("coordinated file reads observe complete values across independent writers", async (context) => {
	const { root, files } = await fixture(context);
	const path = join(root, "current", "workspace", "shared.txt");
	const second = createRunFileCoordinator(root);
	const values = ["a".repeat(100000), "б".repeat(100000)];
	await files.writeText(path, values[0]);
	await chmod(path, 0o640);
	await Promise.all(
		Array.from({ length: 12 }, async (_, index) => {
			await second.writeText(path, values[index % 2]);
			assert.ok(values.includes(await files.readText(path)));
		}),
	);
	assert.equal((await stat(path)).mode & 0o777, 0o640);
});

for (const layout of ["symlink", "legacy"] as const) {
	test(`scheduler locking retains ${layout} state loading and writes`, async (context) => {
		const { root } = await fixture(context);
		await NornRunStateStore.create(root, {
			projectRoot: root,
			id: "layout",
			name: "layout",
			entrypointWorkflowId: "test.step",
			workspace: root,
			current: { workflowId: "test.step", args: {}, cwd: root, env: {} },
			startedAt: new Date().toISOString(),
		});
		const currentPath = join(root, "current", "run-state.json");
		const target =
			layout === "symlink"
				? join(root, "different-name.json")
				: join(root, "current", "runtime-state.json");
		await rename(currentPath, target);
		if (layout === "symlink") await symlink(target, currentPath);
		const reopened = await NornRunStateStore.load(root);
		await reopened.stopCurrent();
		assert.equal(
			(await NornRunStateStore.load(root)).currentState().status,
			"stopped",
		);
		assert.equal(
			JSON.parse(await readFile(currentPath, "utf8")).status,
			"stopped",
		);
		if (layout === "symlink")
			assert.equal(await realpath(currentPath), await realpath(target));
	});
}

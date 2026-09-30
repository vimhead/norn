import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
	NornRunPruneOptions,
	NornRunPruneResult,
	NornRunStatus,
} from "@vimhead.dev/norn";
import { test, vi, type TestContext } from "vitest";
import { createNornClient } from "../packages/cli/src/client.ts";
import { NornRunLease } from "../packages/cli/src/internal/run-lease.ts";
import { writeRunResumeRequest } from "../packages/cli/src/internal/launch-request.ts";
import {
	NornRunPruner,
	parseRunPruneOptions,
} from "../packages/cli/src/internal/run-pruning.ts";
import {
	getRunInfo,
	NornRunStateStore,
} from "../packages/cli/src/internal/run-state.ts";
import { NornRunStore } from "../packages/cli/src/internal/run-store.ts";

const now = new Date("2026-01-10T12:00:00.000Z");
const execute = promisify(execFile);
const cliPath = fileURLToPath(
	new URL("../packages/cli/bin/norn.mjs", import.meta.url),
);

function options(
	overrides: Partial<NornRunPruneOptions> = {},
): NornRunPruneOptions {
	return {
		deleteRuns: false,
		all: false,
		olderThan: null,
		dryRun: false,
		...overrides,
	};
}

async function createProject(context: TestContext): Promise<string> {
	const project = await mkdtemp(join(tmpdir(), "norn-pruning-test-"));
	context.onTestFinished(() => rm(project, { recursive: true, force: true }));
	await writeFile(
		join(project, "norn.project.json"),
		JSON.stringify({ version: 1, workflows: [] }),
	);
	return project;
}

async function rewriteState(
	runRoot: string,
	changes: Record<string, unknown>,
): Promise<void> {
	const path = join(runRoot, "current/run-state.json");
	const state = JSON.parse(await readFile(path, "utf8"));
	await writeFile(path, JSON.stringify({ ...state, ...changes }));
}

async function createRun(input: {
	project: string;
	id: string;
	status: NornRunStatus;
	finishedAt: string;
}) {
	const root = join(input.project, ".norn/runs", input.id);
	const store = await NornRunStore.initialize(root);
	const state = await NornRunStateStore.create(root, {
		projectRoot: input.project,
		id: input.id,
		name: input.id,
		entrypointWorkflowId: "test.step",
		workspace: join(root, "current/workspace"),
		current: { workflowId: "test.step", args: {}, cwd: input.project, env: {} },
		startedAt: "2025-01-01T00:00:00.000Z",
	});
	for (const directory of ["workspace", "logs", "sessions", "artifacts"])
		await mkdir(join(root, "current", directory), { recursive: true });
	const evidence = [
		"workspace/result.txt",
		"logs/output.txt",
		"sessions/conversation.jsonl",
		"artifacts/report.txt",
		"manifest.json",
	];
	for (const path of evidence)
		await writeFile(join(root, "current", path), path);
	const first = await store.snapshotCurrent("initial");
	if (input.status === "completed")
		await state.completeRun("test.step", { summary: "retained result" });
	else if (input.status === "failed")
		await state.failRun("test.step", { summary: "failure evidence" });
	else if (input.status === "interrupted")
		await state.interruptCurrent(
			{},
			{ description: "Retain pending decision" },
		);
	else if (input.status === "stopped") await state.stopCurrent();
	else if (input.status === "pendingResume")
		await state.prepareForResumeAfterRollback();
	const saved = JSON.parse(
		await readFile(join(root, "current/run-state.json"), "utf8"),
	);
	await rewriteState(root, {
		status: input.status,
		updatedAt: input.finishedAt,
		outcome: saved.outcome
			? { ...saved.outcome, completedAt: input.finishedAt }
			: null,
		failed: saved.failed
			? { ...saved.failed, failedAt: input.finishedAt }
			: null,
	});
	const second = await store.snapshotCurrent("latest");
	await store.snapshotCurrent("orphan");
	await writeFile(
		join(root, "current/checkpoints.json"),
		JSON.stringify([first, second]),
	);
	await writeFile(join(root, "store/refs/current"), second.id);
	return { root, store, first, second, evidence };
}

async function assertEvidenceRetained(
	run: Awaited<ReturnType<typeof createRun>>,
) {
	for (const path of run.evidence)
		assert.equal(await readFile(join(run.root, "current", path), "utf8"), path);
}

function prune(projectRoot: string, pruneOptions: NornRunPruneOptions) {
	return new NornRunPruner({ projectRoot, options: pruneOptions, now }).prune();
}

const old = "2026-01-08T12:00:00.000Z";
const recent = "2026-01-10T11:00:00.000Z";

test("default pruning retires whole stores only for old completed/failed runs and preserves evidence", async (context) => {
	const project = await createProject(context);
	const runs = [];
	for (const status of [
		"completed",
		"failed",
		"running",
		"stopped",
		"interrupted",
		"pendingResume",
	] as const)
		runs.push(
			await createRun({ project, id: status, status, finishedAt: old }),
		);
	const recentRun = await createRun({
		project,
		id: "recent",
		status: "completed",
		finishedAt: recent,
	});
	const boundary = await createRun({
		project,
		id: "boundary",
		status: "failed",
		finishedAt: "2026-01-09T12:00:00.000Z",
	});
	const result = await prune(project, options());
	assert.equal(result.mode, "checkpoints");
	assert.equal(result.olderThan, "24h");
	assert.deepEqual(
		result.runs
			.filter((run) => run.status === "pruned")
			.map((run) => run.id)
			.sort(),
		["completed", "failed"],
	);
	for (const run of runs.slice(0, 2)) {
		await assert.rejects(readFile(join(run.root, "store/refs/current")), {
			code: "ENOENT",
		});
		assert.ok(!(await readdir(run.root)).includes("store"));
		await assertEvidenceRetained(run);
		assert.equal(
			(await getRunInfo(run.root)).outcome?.metadata?.summary,
			run === runs[0] ? "retained result" : "failure evidence",
		);
		const reopened = await NornRunStore.open(run.root);
		assert.deepEqual(await reopened.listCheckpoints(), []);
		await assert.rejects(
			reopened.restoreSnapshot(run.first.id, undefined),
			/history was pruned/,
		);
		await assert.rejects(
			reopened.restoreCurrentSnapshot(),
			/history was pruned/,
		);
		await assert.rejects(
			reopened.snapshotCurrent("cannot revive history"),
			/history was pruned/,
		);
	}
	for (const run of [...runs.slice(2), recentRun, boundary]) {
		assert.equal(
			(await (await NornRunStore.open(run.root)).listCheckpoints()).length,
			2,
		);
		await assertEvidenceRetained(run);
	}
	const repeated = await prune(project, options());
	assert.equal(
		repeated.runs.filter((run) => run.status === "pruned").length,
		2,
	);
});

test("delete-runs keeps the default age limit; all changes only age, never status", async (context) => {
	const project = await createProject(context);
	const oldRun = await createRun({
		project,
		id: "old",
		status: "completed",
		finishedAt: old,
	});
	const recentRun = await createRun({
		project,
		id: "recent",
		status: "failed",
		finishedAt: recent,
	});
	const protectedRuns = [];
	for (const status of [
		"running",
		"stopped",
		"interrupted",
		"pendingResume",
	] as const)
		protectedRuns.push(
			await createRun({ project, id: status, status, finishedAt: old }),
		);
	const result = await prune(project, options({ deleteRuns: true }));
	assert.deepEqual(
		result.runs.filter((run) => run.status === "pruned").map((run) => run.id),
		["old"],
	);
	await assert.rejects(readdir(oldRun.root), { code: "ENOENT" });
	await assertEvidenceRetained(recentRun);
	const all = await prune(project, options({ deleteRuns: true, all: true }));
	assert.equal(all.olderThan, null);
	assert.deepEqual(
		all.runs.filter((run) => run.status === "pruned").map((run) => run.id),
		["recent"],
	);
	await assert.rejects(readdir(recentRun.root), { code: "ENOENT" });
	for (const run of protectedRuns) await assertEvidenceRetained(run);
});

test("age uses terminal timestamps rather than creation or updatedAt; duration can be customized", async (context) => {
	const project = await createProject(context);
	const run = await createRun({
		project,
		id: "recent",
		status: "completed",
		finishedAt: recent,
	});
	await rewriteState(run.root, { updatedAt: old });
	assert.equal((await prune(project, options())).runs[0].status, "skipped");
	assert.equal(
		(await prune(project, options({ olderThan: "30m" }))).runs[0].status,
		"pruned",
	);
});

for (const deleteRuns of [false, true]) {
	test(`dry-run is read-only for ${deleteRuns ? "whole runs" : "checkpoints"} and respects executor ownership`, async (context) => {
		const project = await createProject(context);
		const run = await createRun({
			project,
			id: "candidate",
			status: "failed",
			finishedAt: old,
		});
		const before = await readdir(run.root, { recursive: true });
		const planned = await prune(project, options({ dryRun: true, deleteRuns }));
		assert.equal(planned.runs[0].status, "planned");
		assert.deepEqual(await readdir(run.root, { recursive: true }), before);
		const lease = await NornRunLease.acquire(run.root);
		try {
			for (const dryRun of [true, false]) {
				const result = await prune(project, options({ dryRun, deleteRuns }));
				assert.equal(result.runs[0].status, "skipped");
				assert.match(result.runs[0].reason ?? "", /owned/);
			}
			await lease.assertOwned();
			await assertEvidenceRetained(run);
		} finally {
			await lease.release();
		}
	});
}

test("queued resumes remain protected even if the saved state is old and failed", async (context) => {
	const project = await createProject(context);
	const run = await createRun({
		project,
		id: "queued",
		status: "failed",
		finishedAt: old,
	});
	await writeRunResumeRequest(run.root, {
		version: 2,
		type: "resume",
		id: "queued",
		createdAt: now.toISOString(),
	});
	const result = await prune(project, options({ deleteRuns: true, all: true }));
	assert.equal(result.runs[0].status, "skipped");
	await assertEvidenceRetained(run);
});

test("eligibility is rechecked after acquiring the existing lease", async (context) => {
	const project = await createProject(context);
	const run = await createRun({
		project,
		id: "changed",
		status: "completed",
		finishedAt: old,
	});
	const acquire = NornRunLease.acquire.bind(NornRunLease);
	const spy = vi
		.spyOn(NornRunLease, "acquire")
		.mockImplementation(async (root, processOwner) => {
			const lease = await acquire(root, processOwner);
			await rewriteState(root, {
				status: "pendingResume",
				current: { workflowId: "test.step", args: {}, cwd: project, env: {} },
			});
			return lease;
		});
	context.onTestFinished(() => spy.mockRestore());
	assert.equal(
		(await prune(project, options({ deleteRuns: true, all: true }))).runs[0]
			.status,
		"skipped",
	);
	await assertEvidenceRetained(run);
	assert.ok(!(await readdir(run.root)).includes("active.lock"));
});

test("invalid terminal timestamps skip deletion and whole-store pruning supports old saved runs", async (context) => {
	const project = await createProject(context);
	const invalid = await createRun({
		project,
		id: "invalid",
		status: "completed",
		finishedAt: "invalid",
	});
	const legacy = await createRun({
		project,
		id: "legacy",
		status: "failed",
		finishedAt: old,
	});
	await rewriteState(legacy.root, { version: 1 });
	const result = await prune(project, options());
	assert.equal(
		result.runs.find((run) => run.id === "invalid")?.status,
		"skipped",
	);
	assert.equal(
		result.runs.find((run) => run.id === "legacy")?.status,
		"pruned",
	);
	await assertEvidenceRetained(invalid);
	await assertEvidenceRetained(legacy);
});

test("a per-run failure is reported without deleting evidence or blocking other runs, and CLI exits nonzero", async (context) => {
	const project = await createProject(context);
	const broken = await createRun({
		project,
		id: "broken",
		status: "failed",
		finishedAt: "2020-01-01T00:00:00.000Z",
	});
	const healthy = await createRun({
		project,
		id: "healthy",
		status: "completed",
		finishedAt: old,
	});
	await rm(join(broken.root, "store"), { recursive: true });
	const result = await prune(project, options());
	assert.equal(
		result.runs.find((run) => run.id === "broken")?.status,
		"failed",
	);
	assert.equal(
		result.runs.find((run) => run.id === "healthy")?.status,
		"pruned",
	);
	await assertEvidenceRetained(broken);
	await assertEvidenceRetained(healthy);
	assert.ok(!(await readdir(broken.root)).includes("active.lock"));
	await assert.rejects(
		execute(process.execPath, [cliPath, "runs", "prune"], { cwd: project }),
		(error: unknown) => {
			assert.ok(
				error instanceof Error &&
					"stdout" in error &&
					typeof error.stdout === "string",
			);
			assert.equal(
				JSON.parse(error.stdout).prune.runs.find(
					(run: { id: string }) => run.id === "broken",
				).status,
				"failed",
			);
			return true;
		},
	);
});

test("option validation rejects ambiguous/destructive combinations and malformed durations", () => {
	for (const args of [
		["--all"],
		["--all", "--delete-runs", "--older-than", "1d"],
		["--older-than"],
		["--older-than", "--dry-run"],
		["--older-than", "-1h"],
		["--older-than", "NaN"],
		["--older-than", "1"],
		["--older-than", "Infinityh"],
		["--older-than", "999999999999999999999w"],
		["--delete-runs", "--delete-runs"],
		["--unknown"],
		["run-id"],
	])
		assert.throws(
			() =>
				new NornRunPruner({
					projectRoot: "/unused",
					options: parseRunPruneOptions(args),
					now,
				}),
		);
	for (const duration of ["0h", "1ms", "2s", "30m", "24h", "1.5d", "2w"])
		assert.doesNotThrow(
			() =>
				new NornRunPruner({
					projectRoot: "/unused",
					options: parseRunPruneOptions(["--older-than", duration]),
					now,
				}),
		);
});

test("CLI discovery, client preview, checkpoint retirement, and heavy prune agree", async (context) => {
	const project = await createProject(context);
	const run = await createRun({
		project,
		id: "cli",
		status: "failed",
		finishedAt: "2020-01-01T00:00:00.000Z",
	});
	const invoke = async (args: readonly string[]) =>
		JSON.parse(
			(await execute(process.execPath, [cliPath, ...args], { cwd: project }))
				.stdout,
		);
	const contract = await invoke(["commands", "inspect", "runs.prune"]);
	assert.match(JSON.stringify(contract), /--delete-runs/);
	assert.match(
		(
			await execute(process.execPath, [cliPath, "help", "runs", "prune"], {
				cwd: project,
			})
		).stdout,
		/--older-than/,
	);
	const client = createNornClient({ spawnCwd: project });
	const preview = await client.runs.prune(options({ dryRun: true }));
	assert.equal(preview.runs[0].status, "planned");
	await assertEvidenceRetained(run);
	const result = await client.runs.prune(options());
	assert.equal(result.runs[0].status, "pruned");
	assert.deepEqual(await client.runs.checkpoints("cli"), []);
	assert.equal((await client.runs.inspect("cli")).status, "failed");
	await assert.rejects(
		client.runs.rollback("cli", run.first.id),
		/history was pruned/,
	);
	const deletion: { prune: NornRunPruneResult } = await invoke([
		"runs",
		"prune",
		"--delete-runs",
		"--all",
	]);
	assert.equal(deletion.prune.runs[0].status, "pruned");
	assert.deepEqual(await client.runs.list(), []);
});

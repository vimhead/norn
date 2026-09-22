import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, vi, type TestContext } from "vitest";
import { summarize } from "../examples/getting-started/plugin.ts";
import { NornAgentRunner } from "../packages/cli/src/internal/agents.ts";
import { NornEngine } from "../packages/cli/src/internal/engine.ts";

const execute = promisify(execFile);

async function runGit(input: { cwd: string; args: string[] }): Promise<string> {
	const result = await execute(
		"git",
		[
			"-c",
			"user.name=Norn test",
			"-c",
			"user.email=norn@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"-c",
			`core.hooksPath=${devNull}`,
			...input.args,
		],
		{ cwd: input.cwd },
	);
	return result.stdout;
}

async function createFixture(context: TestContext) {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "norn-getting-started-")),
	);
	context.onTestFinished(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	});
	vi.stubEnv("GIT_CONFIG_GLOBAL", devNull);
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
	const project = join(root, "project");
	const repositoryPath = join(root, "source checkout's repository");
	await mkdir(project);
	await mkdir(repositoryPath);
	const prompt = vi
		.spyOn(NornAgentRunner.prototype, "prompt")
		.mockRejectedValue(new Error("Unexpected model call"));
	const engine = new NornEngine({ cwd: project });
	engine.registerWorkflows([summarize]);
	return { project, repositoryPath, engine, prompt };
}

async function initializeRepository(repositoryPath: string) {
	await runGit({
		cwd: repositoryPath,
		args: ["init", "--initial-branch=main"],
	});
	await writeFile(join(repositoryPath, "staged.txt"), "original staged file\n");
	await writeFile(
		join(repositoryPath, "unstaged.txt"),
		"original unstaged file\n",
	);
	await runGit({ cwd: repositoryPath, args: ["add", "."] });
	await runGit({
		cwd: repositoryPath,
		args: ["commit", "-m", "Initial revision"],
	});
}

test("getting started records the tracked Git diff, prompts with it, and saves the response outside the repository", async (context) => {
	const { project, repositoryPath, engine, prompt } =
		await createFixture(context);
	await initializeRepository(repositoryPath);
	await writeFile(join(repositoryPath, "staged.txt"), "staged change\n");
	await runGit({ cwd: repositoryPath, args: ["add", "staged.txt"] });
	await writeFile(join(repositoryPath, "unstaged.txt"), "unstaged change\n");
	await writeFile(
		join(repositoryPath, "untracked.txt"),
		"not part of the patch\n",
	);
	const patch = await runGit({
		cwd: repositoryPath,
		args: ["diff", "HEAD", "--"],
	});
	const stagedPatch = await runGit({
		cwd: repositoryPath,
		args: ["diff", "--cached", "--"],
	});
	prompt.mockResolvedValue({ text: "Updates both tracked files." });

	const result = await engine.runWorkflow(
		summarize,
		{ repositoryPath },
		undefined,
	);
	assert.equal(result.status, "completed");
	assert.equal(prompt.mock.calls.length, 1);
	const [request] = prompt.mock.calls[0];
	assert.equal(request.cwd, result.workspace);
	assert.deepEqual(request.tools, []);
	assert.ok(request.prompt.endsWith(patch));
	assert.ok(request.prompt.includes("+staged change"));
	assert.ok(request.prompt.includes("+unstaged change"));
	assert.ok(!request.prompt.includes("not part of the patch"));
	assert.equal(result.metadata?.data?.summaryPath, "summary.txt");
	assert.equal(
		await readFile(join(result.workspace, "summary.txt"), "utf8"),
		"Updates both tracked files.\n",
	);
	const diffLog = result.metadata?.logs?.diff;
	assert.ok(diffLog);
	assert.equal(
		await readFile(
			join(
				project,
				".norn/runs",
				result.id,
				"current/logs",
				`${diffLog.id}.log`,
			),
			"utf8",
		),
		patch,
	);
	assert.equal(
		await runGit({ cwd: repositoryPath, args: ["diff", "HEAD", "--"] }),
		patch,
	);
	assert.equal(
		await runGit({ cwd: repositoryPath, args: ["diff", "--cached", "--"] }),
		stagedPatch,
	);
	await assert.rejects(readFile(join(repositoryPath, "summary.txt")), {
		code: "ENOENT",
	});
});

test("getting started writes a deterministic empty-diff result without a model call", async (context) => {
	const { repositoryPath, engine, prompt } = await createFixture(context);
	await initializeRepository(repositoryPath);
	await writeFile(
		join(repositoryPath, "untracked.txt"),
		"untracked files are excluded\n",
	);
	const result = await engine.runWorkflow(
		summarize,
		{ repositoryPath },
		undefined,
	);
	assert.equal(result.status, "completed");
	assert.equal(prompt.mock.calls.length, 0);
	assert.equal(result.metadata?.data?.summaryPath, "summary.txt");
	assert.equal(
		await readFile(join(result.workspace, "summary.txt"), "utf8"),
		"No tracked changes relative to HEAD.\n",
	);
});

for (const isRepository of [false, true]) {
	test(`getting started retains Git errors without prompting: ${isRepository ? "no HEAD" : "not a repository"}`, async (context) => {
		const { project, repositoryPath, engine, prompt } =
			await createFixture(context);
		if (isRepository)
			await runGit({
				cwd: repositoryPath,
				args: ["init", "--initial-branch=main"],
			});
		const result = await engine.runWorkflow(
			summarize,
			{ repositoryPath },
			undefined,
		);
		assert.equal(result.status, "failed");
		assert.equal(prompt.mock.calls.length, 0);
		assert.match(
			result.metadata?.summary ?? "",
			/Could not read git diff HEAD/,
		);
		const stderr = result.metadata?.logs?.stderr;
		assert.ok(stderr);
		const error = await readFile(
			join(
				project,
				".norn/runs",
				result.id,
				"current/logs",
				`${stderr.id}.log`,
			),
			"utf8",
		);
		assert.ok(error.length > 0);
		await assert.rejects(readFile(join(result.workspace, "summary.txt")), {
			code: "ENOENT",
		});
	});
}

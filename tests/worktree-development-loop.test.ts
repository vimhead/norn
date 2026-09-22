import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, vi, type TestContext } from "vitest";
import { planningWorkflow } from "../examples/worktree-development-loop/workflows/planning/execute.ts";
import { implementationWorkflow } from "../examples/worktree-development-loop/workflows/implementation/execute.ts";
import { developmentLoopWorkflow } from "../examples/worktree-development-loop/workflows/development-loop/execute.ts";
import { reviewRouterWorkflow } from "../examples/worktree-development-loop/workflows/review-router/execute.ts";
import { NornAgentResponseCollector } from "../packages/cli/src/internal/agent-response-tool.ts";
import { NornRunLogs } from "../packages/cli/src/internal/logs.ts";
import { NornRunLogger } from "../packages/cli/src/internal/run-log.ts";
import { createRunFileCoordinator } from "../packages/cli/src/internal/file-coordinator.ts";
import { NornExecutionContext } from "../packages/cli/src/internal/execution-context.ts";

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
			...input.args,
		],
		{ cwd: input.cwd },
	);
	return result.stdout.trim();
}

async function createExampleRun(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "norn-worktree-example-"));
	context.onTestFinished(async () => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	});
	vi.stubEnv("GIT_CONFIG_GLOBAL", devNull);
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
	const runRoot = join(root, "run");
	const currentRoot = join(runRoot, "current");
	const workspace = join(currentRoot, "workspace");
	await mkdir(workspace, { recursive: true });
	const files = createRunFileCoordinator(runRoot);
	const execution = new NornExecutionContext({
		id: "worktree-example",
		runRoot: currentRoot,
		responseCollector: new NornAgentResponseCollector(),
		logs: new NornRunLogs(join(currentRoot, "logs"), files),
		logger: new NornRunLogger({
			manifestPath: join(currentRoot, "manifest.json"),
			files,
			manifest: {
				id: "worktree-example",
				name: "worktree-example",
				workflowId: developmentLoopWorkflow.id,
				runRoot,
				workspace,
				initialCwd: workspace,
				startedAt: new Date().toISOString(),
			},
		}),
	});
	const unexpectedAgentCall = new Error(
		"Setup and routing tests must not prompt an agent",
	);
	vi.spyOn(execution.agents, "prompt").mockRejectedValue(unexpectedAgentCall);
	vi.spyOn(execution.agents, "createSession").mockRejectedValue(
		unexpectedAgentCall,
	);
	return {
		root,
		context: {
			paths: { project: root, workspace },
			run: execution.run,
			agents: execution.agents,
			commands: execution.commands,
			logs: execution.logs,
		},
	};
}

async function createSourceRepository(root: string) {
	const repositoryRoot = join(root, "source checkout's repository");
	await mkdir(repositoryRoot);
	await runGit({
		cwd: repositoryRoot,
		args: ["init", "--initial-branch=main"],
	});
	await writeFile(join(repositoryRoot, "tracked.txt"), "base revision\n");
	await runGit({ cwd: repositoryRoot, args: ["add", "tracked.txt"] });
	await runGit({
		cwd: repositoryRoot,
		args: ["commit", "-m", "Base revision"],
	});
	const baseRevision = await runGit({
		cwd: repositoryRoot,
		args: ["rev-parse", "HEAD"],
	});
	await writeFile(join(repositoryRoot, "tracked.txt"), "latest revision\n");
	await runGit({
		cwd: repositoryRoot,
		args: ["commit", "-am", "Latest revision"],
	});
	const headRevision = await runGit({
		cwd: repositoryRoot,
		args: ["rev-parse", "HEAD"],
	});
	await writeFile(
		join(repositoryRoot, "tracked.txt"),
		"uncommitted source change\n",
	);
	await writeFile(
		join(repositoryRoot, "local-only.txt"),
		"untracked source file\n",
	);
	const sourceStatus = await runGit({
		cwd: repositoryRoot,
		args: ["status", "--porcelain"],
	});
	return { repositoryRoot, baseRevision, headRevision, sourceStatus };
}

test("worktree setup checks out the requested committed revision without changing the source repository", async (context) => {
	const { root, context: workflowContext } = await createExampleRun(context);
	const { paths } = workflowContext;
	const source = await createSourceRepository(root);
	const args = {
		task: "Update the tracked file",
		baseRef: source.baseRevision,
		maxIterations: 3,
	};
	const result = await developmentLoopWorkflow.execute({
		...workflowContext,
		args,
		config: undefined,
		scope: {
			id: "worktreeDevelopmentLoop",
			config: { repositoryRoot: source.repositoryRoot },
		},
	});
	assert.deepEqual(
		result,
		planningWorkflow({
			task: args.task,
			repositoryPath: "repo",
			maxIterations: 3,
		}),
	);
	const clone = join(paths.workspace, "repo");
	assert.equal(
		await runGit({ cwd: clone, args: ["rev-parse", "HEAD"] }),
		source.baseRevision,
	);
	assert.equal(
		await readFile(join(clone, "tracked.txt"), "utf8"),
		"base revision\n",
	);
	await assert.rejects(readFile(join(clone, "local-only.txt")), {
		code: "ENOENT",
	});
	await writeFile(join(clone, "tracked.txt"), "workflow change\n");
	assert.equal(
		await runGit({ cwd: source.repositoryRoot, args: ["rev-parse", "HEAD"] }),
		source.headRevision,
	);
	assert.equal(
		await readFile(join(source.repositoryRoot, "tracked.txt"), "utf8"),
		"uncommitted source change\n",
	);
	assert.equal(
		await readFile(join(source.repositoryRoot, "local-only.txt"), "utf8"),
		"untracked source file\n",
	);
	assert.equal(
		await runGit({
			cwd: source.repositoryRoot,
			args: ["status", "--porcelain"],
		}),
		source.sourceStatus,
	);
});

test("worktree setup rejects a missing base revision before transitioning to planning", async (context) => {
	const { root, context: workflowContext } = await createExampleRun(context);
	const { repositoryRoot } = await createSourceRepository(root);
	await assert.rejects(
		async () =>
			developmentLoopWorkflow.execute({
				...workflowContext,
				args: {
					task: "Do not reach planning",
					baseRef: "missing-base-revision",
					maxIterations: 3,
				},
				config: undefined,
				scope: { id: "worktreeDevelopmentLoop", config: { repositoryRoot } },
			}),
		/materialize-workspace-repository failed/,
	);
});

test("the worktree review gate permits decision and summary patches", () => {
	assert.deepEqual(reviewRouterWorkflow.gate?.fields, ["decision", "summary"]);
});

for (const scenario of [
	{
		decision: "accept",
		iteration: 3,
		resultType: "complete",
		status: "done",
		summary: "Implementation accepted after 3 iteration(s).",
	},
	{
		decision: "revise",
		iteration: 1,
		resultType: "next",
		status: null,
		summary: null,
	},
	{
		decision: "blocked",
		iteration: 3,
		resultType: "fail",
		status: "blocked",
		summary: "Selected decision after checking evidence.",
	},
	{
		decision: "revise",
		iteration: 3,
		resultType: "fail",
		status: "needs-attention",
		summary: "Maximum iteration count reached after 3 iteration(s).",
	},
] as const) {
	test(`worktree review ${scenario.decision} at iteration ${scenario.iteration}/3 returns ${scenario.resultType}`, async (context) => {
		const { context: workflowContext } = await createExampleRun(context);
		const { paths } = workflowContext;
		const task = "Update the tracked file";
		const planPath = "planning/plan.md";
		await mkdir(join(paths.workspace, "planning"), { recursive: true });
		await mkdir(join(paths.workspace, "review"), { recursive: true });
		await writeFile(
			join(paths.workspace, planPath),
			"Update the file and verify it.\n",
		);
		const automatedReview = {
			decision: "revise",
			summary: "Automated review evidence.",
		};
		const automatedReviewPath = `review/iteration-${scenario.iteration}-automated.json`;
		await writeFile(
			join(paths.workspace, automatedReviewPath),
			JSON.stringify(automatedReview),
		);
		const args = {
			task,
			repositoryPath: "repo",
			maxIterations: 3,
			planPath,
			iteration: scenario.iteration,
			decision: scenario.decision,
			summary: "Selected decision after checking evidence.",
			automatedReviewPath,
		};
		const result = await reviewRouterWorkflow.execute({
			...workflowContext,
			args,
			config: undefined,
			scope: {
				id: "worktreeDevelopmentLoop",
				config: { repositoryRoot: paths.project },
			},
		});
		assert.equal(result.type, scenario.resultType);
		const reviewPath = `review/iteration-${scenario.iteration}-decision.json`;
		assert.deepEqual(
			JSON.parse(await readFile(join(paths.workspace, reviewPath), "utf8")),
			{
				decision: args.decision,
				summary: args.summary,
				automatedReviewPath,
			},
		);
		assert.deepEqual(
			JSON.parse(
				await readFile(join(paths.workspace, automatedReviewPath), "utf8"),
			),
			automatedReview,
		);
		if (result.type === "next") {
			assert.deepEqual(
				result,
				implementationWorkflow({
					task,
					repositoryPath: "repo",
					maxIterations: 3,
					planPath,
					previousReviewPath: reviewPath,
					iteration: 2,
				}),
			);
		} else {
			assert.equal(result.metadata?.summary, scenario.summary);
			assert.deepEqual(result.metadata?.data, {
				status: scenario.status,
				repositoryPath: "repo",
				planPath,
				reviewPath,
				iterations: scenario.iteration,
				lastReview: {
					decision: args.decision,
					summary: args.summary,
					reviewPath,
				},
			});
		}
	});
}

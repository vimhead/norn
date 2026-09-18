import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, vi, type TestContext } from "vitest";
import { worktreeDevelopmentLoopManifest as manifest } from "../examples/worktree-development-loop/manifest.ts";
import { executeDevelopmentLoopWorkflow } from "../examples/worktree-development-loop/workflows/development-loop/execute.ts";
import { executeReviewRouterWorkflow } from "../examples/worktree-development-loop/workflows/review-router/execute.ts";
import { NornAgentResponseCollector } from "../packages/cli/src/internal/agent-response-tool.ts";
import { NornArtifacts } from "../packages/cli/src/internal/artifacts.ts";
import { NornRunLogs } from "../packages/cli/src/internal/logs.ts";
import { NornRunLogger } from "../packages/cli/src/internal/run-log.ts";
import { initializeRunResources } from "../packages/cli/src/internal/run-resources.ts";
import { NornRunContext } from "../packages/cli/src/internal/run.ts";

const execute = promisify(execFile);

async function runGit(input: { cwd: string; args: string[] }): Promise<string> {
	const result = await execute("git", [
		"-c", "user.name=Norn test", "-c", "user.email=norn@example.invalid", "-c", "commit.gpgsign=false",
		...input.args,
	], { cwd: input.cwd });
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
	const { resources, state } = await initializeRunResources(runRoot);
	const run = new NornRunContext({
		id: "worktree-example",
		runRoot: currentRoot,
		projectRoot: root,
		workspace,
		cwd: workspace,
		isolationMode: "runWorkspace",
		responseCollector: new NornAgentResponseCollector(),
		resources,
		state,
		artifacts: new NornArtifacts(join(currentRoot, "artifacts"), resources.files),
		logs: new NornRunLogs(join(currentRoot, "logs"), resources.files),
		logger: new NornRunLogger({
			manifestPath: join(currentRoot, "manifest.json"),
			files: resources.files,
			manifest: {
				id: "worktree-example", name: "worktree-example", workflowId: manifest.workflows.developmentLoop.id,
				runRoot, workspace, initialCwd: workspace, startedAt: new Date().toISOString(),
			},
		}),
	});
	const unexpectedAgentCall = new Error("Setup and routing tests must not prompt an agent");
	vi.spyOn(run.agents, "prompt").mockRejectedValue(unexpectedAgentCall);
	vi.spyOn(run.agents, "createSession").mockRejectedValue(unexpectedAgentCall);
	return { root, run };
}

async function createSourceRepository(root: string) {
	const repositoryRoot = join(root, "source checkout's repository");
	await mkdir(repositoryRoot);
	await runGit({ cwd: repositoryRoot, args: ["init", "--initial-branch=main"] });
	await writeFile(join(repositoryRoot, "tracked.txt"), "base revision\n");
	await runGit({ cwd: repositoryRoot, args: ["add", "tracked.txt"] });
	await runGit({ cwd: repositoryRoot, args: ["commit", "-m", "Base revision"] });
	const baseRevision = await runGit({ cwd: repositoryRoot, args: ["rev-parse", "HEAD"] });
	await writeFile(join(repositoryRoot, "tracked.txt"), "latest revision\n");
	await runGit({ cwd: repositoryRoot, args: ["commit", "-am", "Latest revision"] });
	const headRevision = await runGit({ cwd: repositoryRoot, args: ["rev-parse", "HEAD"] });
	await writeFile(join(repositoryRoot, "tracked.txt"), "uncommitted source change\n");
	await writeFile(join(repositoryRoot, "local-only.txt"), "untracked source file\n");
	const sourceStatus = await runGit({ cwd: repositoryRoot, args: ["status", "--porcelain"] });
	return { repositoryRoot, baseRevision, headRevision, sourceStatus };
}

test("worktree setup checks out the requested committed revision without changing the source repository", async context => {
	const { root, run } = await createExampleRun(context);
	const source = await createSourceRepository(root);
	const params = { task: "Update the tracked file", baseRef: source.baseRevision, maxIterations: 3 };
	const result = await executeDevelopmentLoopWorkflow(run, params, { repositoryRoot: source.repositoryRoot });
	assert.deepEqual(result, manifest.workflows.planning({ task: params.task }));
	assert.equal(await run.state.get(manifest.states.developmentLoop.repositoryPath), "repo");
	assert.equal(await run.state.get(manifest.states.developmentLoop.task), params.task);
	assert.equal(await run.state.get(manifest.states.developmentLoop.currentIteration), 1);
	assert.equal(await run.state.get(manifest.states.developmentLoop.maxIterations), 3);
	const clone = run.path("repo");
	assert.equal(await runGit({ cwd: clone, args: ["rev-parse", "HEAD"] }), source.baseRevision);
	assert.equal(await readFile(join(clone, "tracked.txt"), "utf8"), "base revision\n");
	await assert.rejects(readFile(join(clone, "local-only.txt")), { code: "ENOENT" });
	await writeFile(join(clone, "tracked.txt"), "workflow change\n");
	assert.equal(await runGit({ cwd: source.repositoryRoot, args: ["rev-parse", "HEAD"] }), source.headRevision);
	assert.equal(await readFile(join(source.repositoryRoot, "tracked.txt"), "utf8"), "uncommitted source change\n");
	assert.equal(await readFile(join(source.repositoryRoot, "local-only.txt"), "utf8"), "untracked source file\n");
	assert.equal(await runGit({ cwd: source.repositoryRoot, args: ["status", "--porcelain"] }), source.sourceStatus);
});

test("worktree setup rejects a missing base revision before recording successful initialization", async context => {
	const { root, run } = await createExampleRun(context);
	const { repositoryRoot } = await createSourceRepository(root);
	await assert.rejects(executeDevelopmentLoopWorkflow(run, {
		task: "Do not reach planning", baseRef: "missing-base-revision", maxIterations: 3,
	}, { repositoryRoot }), /materialize-workspace-repository failed/);
	assert.equal(await run.state.getOptional(manifest.states.developmentLoop.repositoryPath), undefined);
	assert.equal(await run.state.getOptional(manifest.states.developmentLoop.currentIteration), undefined);
});

test("the worktree review gate permits decision and summary patches", () => {
	assert.deepEqual(manifest.workflows.reviewRouter.gate, { enabled: true, fields: ["decision", "summary"] });
});

for (const scenario of [
	{ decision: "accept", iteration: 3, resultType: "complete", status: "done", summary: "Implementation accepted after 3 iteration(s)." },
	{ decision: "revise", iteration: 1, resultType: "next", status: null, summary: null },
	{ decision: "blocked", iteration: 3, resultType: "fail", status: "blocked", summary: "Selected decision after checking evidence." },
	{ decision: "revise", iteration: 3, resultType: "fail", status: "needs-attention", summary: "Maximum iteration count reached after 3 iteration(s)." },
] as const) {
	test(`worktree review ${scenario.decision} at iteration ${scenario.iteration}/3 returns ${scenario.resultType}`, async context => {
		const { run } = await createExampleRun(context);
		const task = "Update the tracked file";
		const planArtifact = await run.artifacts.write("planning/plan.md", "Update the file and verify it.\n");
		const automatedReview = { decision: "revise", summary: "Automated review evidence." };
		const automatedReviewArtifact = await run.artifacts.write(
			`review/iteration-${scenario.iteration}-automated.json`, JSON.stringify(automatedReview),
		);
		await run.state.set(manifest.states.developmentLoop.repositoryPath, "repo");
		await run.state.set(manifest.states.developmentLoop.task, task);
		await run.state.set(manifest.states.developmentLoop.currentIteration, scenario.iteration);
		await run.state.set(manifest.states.developmentLoop.maxIterations, 3);
		await run.state.set(manifest.states.planning.planArtifact, planArtifact);
		const params = {
			iteration: scenario.iteration, decision: scenario.decision,
			summary: "Selected decision after checking evidence.", automatedReviewArtifact,
		};
		const result = await executeReviewRouterWorkflow(run, params);
		assert.equal(result.type, scenario.resultType);
		const reviewArtifact = { path: `review/iteration-${scenario.iteration}-decision.json` };
		assert.deepEqual(JSON.parse(await run.artifacts.read(reviewArtifact)), {
			decision: params.decision, summary: params.summary, automatedReviewArtifact,
		});
		assert.deepEqual(JSON.parse(await run.artifacts.read(automatedReviewArtifact)), automatedReview);
		assert.equal(await run.state.get(manifest.states.review.reviewDecision), params.decision);
		assert.deepEqual(await run.state.get(manifest.states.review.reviewArtifact), reviewArtifact);
		if (result.type === "next") {
			assert.deepEqual(result, manifest.workflows.implementation({ task, iteration: 2 }));
			assert.equal(await run.state.get(manifest.states.developmentLoop.currentIteration), 2);
		} else {
			assert.equal(result.metadata?.summary, scenario.summary);
			assert.deepEqual(result.metadata?.artifacts, { plan: planArtifact, review: reviewArtifact });
			assert.deepEqual(result.metadata?.data, {
				status: scenario.status, repositoryPath: "repo", iterations: scenario.iteration,
				lastReview: { decision: params.decision, summary: params.summary, reviewArtifact },
			});
			assert.equal(await run.state.get(manifest.states.developmentLoop.currentIteration), scenario.iteration);
		}
	});
}

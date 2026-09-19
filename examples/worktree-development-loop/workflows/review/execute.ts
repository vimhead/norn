import { resolve } from "node:path";
import { reviewRouterWorkflow } from "../review-router/execute.ts";
import type { WorkflowResult } from "@vimhead.dev/norn";
import { developmentLoopScope } from "../../scope.ts";
import { reviewArgsSchema } from "./schema.ts";
import { ensureCommandSucceeded } from "../../shared/commands.ts";
import { reviewAgentResponseSchema } from "./schema.ts";

export const reviewWorkflow = developmentLoopScope.workflow({
	id: "review",
	isEntrypoint: false,
	instructions: "Review the current repository boundary changes.",
	args: reviewArgsSchema,
	async execute({ args, paths, run }): Promise<WorkflowResult> {
		const repositoryPath = resolve(paths.run, args.repositoryPath);
		const planArtifact = args.planArtifact;
		const implementationSummary = args.implementationSummary;
		const plan = await run.artifacts.read(planArtifact);
		const diff = await run.commands.run({
			label: `review-${args.iteration}-diff`,
			cwd: repositoryPath,
			command: "git status --short && git diff --stat HEAD -- . && git diff HEAD -- .",
		});
		await ensureCommandSucceeded(diff);
		const diffOutput = await run.logs.read(diff.stdoutLog);
		await run.artifacts.write(`review/iteration-${args.iteration}-diff.txt`, diffOutput);
		const review = await run.agents.prompt({
			label: `review-${args.iteration}`,
			cwd: repositoryPath,
			tools: ["read", "grep", "find", "ls", "bash"],
			prompt: buildReviewPrompt(args.task, plan, implementationSummary, diffOutput),
			response: reviewAgentResponseSchema,
		});
		const automatedReviewArtifact = await run.artifacts.write(`review/iteration-${args.iteration}-automated.json`, JSON.stringify(review, null, 2));
		return reviewRouterWorkflow({
			...args,
			iteration: args.iteration,
			decision: review.decision,
			summary: review.summary,
			automatedReviewArtifact,
		});
	}
});

function buildReviewPrompt(task: string, plan: string, implementationSummary: string, diff: string): string {
	return [
		"Review the current repository changes against the task and plan.",
		"Use accept only when the work is ready. Use revise for fixable issues. Use blocked when manual input is needed. Include review details in the summary.",
		"",
		"Task:",
		task,
		"",
		"Plan:",
		plan,
		"",
		"Implementation summary:",
		implementationSummary,
		"",
		"Diff:",
		diff.slice(0, 40_000),
	].join("\n");
}


import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { reviewRouterWorkflow } from "../review-router/execute.ts";
import type { WorkflowResult } from "@vimhead.dev/norn";
import { developmentLoopScope } from "../../scope.ts";
import { reviewArgsSchema } from "./schema.ts";
import { ensureCommandSucceeded } from "../../shared/commands.ts";
import { reviewAgentResponseSchema } from "./schema.ts";

export const reviewWorkflow = developmentLoopScope.workflow({
	name: "review",
	entrypoint: false,
	args: reviewArgsSchema,
	async execute({
		args,
		paths,
		agents,
		commands,
		logs,
	}): Promise<WorkflowResult> {
		const repositoryPath = resolve(paths.workspace, args.repositoryPath);
		const implementationSummary = args.implementationSummary;
		const plan = await readFile(join(paths.workspace, args.planPath), "utf8");
		const diff = await commands.run({
			label: `review-${args.iteration}-diff`,
			cwd: repositoryPath,
			command:
				"git status --short && git diff --stat HEAD -- . && git diff HEAD -- .",
		});
		await ensureCommandSucceeded(diff);
		const diffOutput = await logs.read(diff.stdoutLog);
		await mkdir(join(paths.workspace, "review"), { recursive: true });
		await writeFile(
			join(paths.workspace, `review/iteration-${args.iteration}-diff.txt`),
			diffOutput,
		);
		const review = await agents.prompt({
			label: `review-${args.iteration}`,
			cwd: repositoryPath,
			tools: ["read", "grep", "find", "ls", "bash"],
			prompt: buildReviewPrompt(
				args.task,
				plan,
				implementationSummary,
				diffOutput,
			),
			response: reviewAgentResponseSchema,
		});
		const automatedReviewPath = `review/iteration-${args.iteration}-automated.json`;
		await writeFile(
			join(paths.workspace, automatedReviewPath),
			JSON.stringify(review, null, 2),
		);
		return reviewRouterWorkflow({
			...args,
			iteration: args.iteration,
			decision: review.decision,
			summary: review.summary,
			automatedReviewPath,
		});
	},
});

function buildReviewPrompt(
	task: string,
	plan: string,
	implementationSummary: string,
	diff: string,
): string {
	return [
		"Review the current repository changes against the task and plan.",
		`Use accept only when the work is ready. Use revise for fixable issues.
Use blocked when manual input is needed. Include review details in the
summary.`,
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

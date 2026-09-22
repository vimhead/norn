import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { implementationWorkflow } from "../implementation/execute.ts";
import type { WorkflowResult } from "@vimhead.dev/norn";
import { developmentLoopScope } from "../../scope.ts";
import { reviewRouterArgsSchema } from "./schema.ts";
import type { StoredReview } from "../review/schema.ts";

export const reviewRouterWorkflow = developmentLoopScope.workflow({
	name: "reviewRouter",
	entrypoint: false,
	gate: {
		enabled: true,
		describe: ({ args }) =>
			`Review iteration ${args.iteration}.
Confirm or edit the automated decision before continuing.
Plan: ${args.planPath}.`,
		fields: ["decision", "summary"] as const,
	},
	args: reviewRouterArgsSchema,
	async execute({ args, paths, run }): Promise<WorkflowResult> {
		const repositoryPath = args.repositoryPath;
		const planPath = args.planPath;
		const currentIteration = args.iteration;
		const maxIterations = args.maxIterations;
		const task = args.task;
		const reviewPath = `review/iteration-${args.iteration}-decision.json`;
		await mkdir(join(paths.workspace, "review"), { recursive: true });
		await writeFile(
			join(paths.workspace, reviewPath),
			JSON.stringify(
				{
					decision: args.decision,
					summary: args.summary,
					automatedReviewPath: args.automatedReviewPath,
				},
				null,
				2,
			),
		);
		const lastReview: StoredReview = {
			decision: args.decision,
			summary: args.summary,
			reviewPath,
		};

		if (args.decision === "accept") {
			return run.complete({
				summary: `Implementation accepted after ${currentIteration} iteration(s).`,
				data: {
					status: "done",
					repositoryPath,
					planPath,
					reviewPath,
					iterations: currentIteration,
					lastReview,
				},
			});
		}

		if (args.decision === "blocked") {
			return run.fail({
				summary: args.summary,
				data: {
					status: "blocked",
					repositoryPath,
					planPath,
					reviewPath,
					iterations: currentIteration,
					lastReview,
				},
			});
		}

		if (currentIteration >= maxIterations) {
			return run.fail({
				summary: `Maximum iteration count reached after ${currentIteration} iteration(s).`,
				data: {
					status: "needs-attention",
					repositoryPath,
					planPath,
					reviewPath,
					iterations: currentIteration,
					lastReview,
				},
			});
		}

		const nextIteration = currentIteration + 1;
		return implementationWorkflow({
			task,
			repositoryPath,
			maxIterations,
			planPath,
			iteration: nextIteration,
			previousReviewPath: reviewPath,
		});
	},
});

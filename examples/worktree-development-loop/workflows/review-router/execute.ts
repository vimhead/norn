import { implementationWorkflow } from "../implementation/execute.ts";
import type { WorkflowResult } from "@vimhead.dev/norn";
import { developmentLoopScope } from "../../scope.ts";
import { reviewRouterArgsSchema } from "./schema.ts";
import type { StoredReview } from "../review/schema.ts";

export const reviewRouterWorkflow = developmentLoopScope.workflow({
	id: "reviewRouter",
	isEntrypoint: false,
	instructions: "Route implementation and review iterations based on the latest review decision.",
	gate: {
		enabled: true,
		describe: ({ args }) => `Review iteration ${args.iteration}. Confirm or edit the automated decision before continuing. Plan: ${args.planArtifact.path}.`,
		fields: ["decision", "summary"] as const,
	},
	args: reviewRouterArgsSchema,
	async execute({ args, run }): Promise<WorkflowResult> {
		const repositoryPath = args.repositoryPath;
		const planArtifact = args.planArtifact;
		const currentIteration = args.iteration;
		const maxIterations = args.maxIterations;
		const task = args.task;
		const reviewArtifact = await run.artifacts.write(
			`review/iteration-${args.iteration}-decision.json`,
			JSON.stringify({ decision: args.decision, summary: args.summary, automatedReviewArtifact: args.automatedReviewArtifact }, null, 2),
		);
		const lastReview: StoredReview = { decision: args.decision, summary: args.summary, reviewArtifact };

		if (args.decision === "accept") {
			return run.complete({
				summary: `Implementation accepted after ${currentIteration} iteration(s).`,
				artifacts: { plan: planArtifact, review: reviewArtifact },
				data: { status: "done", repositoryPath, iterations: currentIteration, lastReview },
			});
		}

		if (args.decision === "blocked") {
			return run.fail({
				summary: args.summary,
				artifacts: { plan: planArtifact, review: reviewArtifact },
				data: { status: "blocked", repositoryPath, iterations: currentIteration, lastReview },
			});
		}

		if (currentIteration >= maxIterations) {
			return run.fail({
				summary: `Maximum iteration count reached after ${currentIteration} iteration(s).`,
				artifacts: { plan: planArtifact, review: reviewArtifact },
				data: { status: "needs-attention", repositoryPath, iterations: currentIteration, lastReview },
			});
		}

		const nextIteration = currentIteration + 1;
		return implementationWorkflow({ task, repositoryPath, maxIterations, planArtifact, iteration: nextIteration, previousReviewArtifact: reviewArtifact });
	}
});

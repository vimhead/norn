import { reviewWorkflow } from "../review/execute.ts";
import type { WorkflowResult } from "@vimhead.dev/norn";
import { developmentLoopScope } from "../../scope.ts";
import { implementationArgsSchema } from "./schema.ts";
import { ensureCommandSucceeded } from "../../shared/commands.ts";
import { implementationAgentResponseSchema } from "./schema.ts";

export const implementationWorkflow = developmentLoopScope.workflow({
	id: "implementation",
	isEntrypoint: false,
	instructions: "Apply one implementation pass in the current repository.",
	args: implementationArgsSchema,
	async execute({ args, run }): Promise<WorkflowResult> {
		const repositoryPath = args.repositoryPath;
		const planArtifact = args.planArtifact;
		const plan = await run.artifacts.read(planArtifact);
		const previousReviewArtifact = args.previousReviewArtifact;
		const previousReview = previousReviewArtifact ? await run.artifacts.read(previousReviewArtifact) : undefined;
		const implementation = await run.agents.prompt({
			label: `implementation-${args.iteration}`,
			cwd: repositoryPath,
			tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
			prompt: buildImplementationPrompt(args.task, plan, args.iteration, previousReview),
			response: implementationAgentResponseSchema,
		});
		const status = await run.commands.run({
			label: `implementation-${args.iteration}-status`,
			cwd: repositoryPath,
			command: "git status --short",
		});
		await ensureCommandSucceeded(status);
		const statusOutput = await run.logs.read(status.stdoutLog);
		await run.artifacts.write(`implementation/iteration-${args.iteration}-status.txt`, statusOutput);
		return reviewWorkflow({ ...args, implementationSummary: implementation.summary });
	}
});

function buildImplementationPrompt(task: string, plan: string, iteration: number, previousReview: string | undefined): string {
	return [
		`Implement iteration ${iteration} for this repository task.`,
		"Modify files as needed in the current repository.",
		"Keep changes focused and run a cheap relevant check when possible.",
		previousReview ? "Address the previous review before making new changes." : undefined,
		"",
		"Task:",
		task,
		"",
		"Plan:",
		plan,
		previousReview ? "" : undefined,
		previousReview ? "Previous review:" : undefined,
		previousReview,
	].filter((line): line is string => line !== undefined).join("\n");
}


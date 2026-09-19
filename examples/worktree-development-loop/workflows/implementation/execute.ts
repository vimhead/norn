import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
	async execute({ args, paths, agents, commands, logs }): Promise<WorkflowResult> {
		const repositoryPath = resolve(paths.workspace, args.repositoryPath);
		const plan = await readFile(join(paths.workspace, args.planPath), "utf8");
		const previousReview = args.previousReviewPath ? await readFile(join(paths.workspace, args.previousReviewPath), "utf8") : undefined;
		const implementation = await agents.prompt({
			label: `implementation-${args.iteration}`,
			cwd: repositoryPath,
			tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
			prompt: buildImplementationPrompt(args.task, plan, args.iteration, previousReview),
			response: implementationAgentResponseSchema,
		});
		const status = await commands.run({
			label: `implementation-${args.iteration}-status`,
			cwd: repositoryPath,
			command: "git status --short",
		});
		await ensureCommandSucceeded(status);
		const statusOutput = await logs.read(status.stdoutLog);
		await mkdir(join(paths.workspace, "implementation"), { recursive: true });
		await writeFile(join(paths.workspace, `implementation/iteration-${args.iteration}-status.txt`), statusOutput);
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


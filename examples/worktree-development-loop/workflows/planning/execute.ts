import { resolve } from "node:path";
import { implementationWorkflow } from "../implementation/execute.ts";
import type { WorkflowResult } from "@vimhead.dev/norn";
import { developmentLoopScope } from "../../scope.ts";
import { planningArgsSchema } from "./schema.ts";
import { planningAgentResponseSchema } from "./schema.ts";

export const planningWorkflow = developmentLoopScope.workflow({
	id: "planning",
	isEntrypoint: false,
	instructions: "Create an implementation plan for a repository task.",
	args: planningArgsSchema,
	async execute({ args, paths, run }): Promise<WorkflowResult> {
		const repositoryPath = resolve(paths.run, args.repositoryPath);
		const planning = await run.agents.prompt({
			label: "planning",
			cwd: repositoryPath,
			tools: ["read", "grep", "find", "ls"],
			prompt: buildPlanningPrompt(args.task),
			response: planningAgentResponseSchema,
		});
		const planArtifact = await run.artifacts.write("planning/plan.md", planning.plan);
		return implementationWorkflow({ ...args, planArtifact, iteration: 1 });
	}
});

function buildPlanningPrompt(task: string): string {
	return [
		"Create a concise implementation plan for this repository task.",
		"Do not modify files in this step.",
		"Include assumptions, planned edits, and checks in the plan.",
		"",
		"Task:",
		task,
	].join("\n");
}

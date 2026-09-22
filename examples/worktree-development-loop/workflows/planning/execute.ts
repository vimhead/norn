import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { implementationWorkflow } from "../implementation/execute.ts";
import type { WorkflowResult } from "@vimhead.dev/norn";
import { developmentLoopScope } from "../../scope.ts";
import { planningArgsSchema } from "./schema.ts";
import { planningAgentResponseSchema } from "./schema.ts";

export const planningWorkflow = developmentLoopScope.workflow({
	name: "planning",
	entrypoint: false,
	args: planningArgsSchema,
	async execute({ args, paths, agents }): Promise<WorkflowResult> {
		const repositoryPath = resolve(paths.workspace, args.repositoryPath);
		const planning = await agents.prompt({
			label: "planning",
			cwd: repositoryPath,
			tools: ["read", "grep", "find", "ls"],
			prompt: buildPlanningPrompt(args.task),
			response: planningAgentResponseSchema,
		});
		const planPath = "planning/plan.md";
		await mkdir(join(paths.workspace, "planning"), { recursive: true });
		await writeFile(join(paths.workspace, planPath), planning.plan);
		return implementationWorkflow({ ...args, planPath, iteration: 1 });
	},
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

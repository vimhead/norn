import { planningWorkflow } from "../planning/execute.ts";
import type { WorkflowResult } from "@vimhead.dev/norn";
import { developmentLoopScope } from "../../scope.ts";
import { developmentLoopArgsSchema } from "./schema.ts";
import { materializeWorkspaceRepository } from "./repository.ts";

export const developmentLoopWorkflow = developmentLoopScope.workflow({
	name: "developmentLoop",
	entrypoint: { instructions: "Plan once, then loop implementation and review in a workspace repository copy. Call this when a repository task should run through planning, implementation, and review." },
	args: developmentLoopArgsSchema,
	async execute({ args, scope, paths, commands }): Promise<WorkflowResult> {
		const repositoryPath = await materializeWorkspaceRepository({ commands, paths, repositoryRoot: scope.config.repositoryRoot, baseRef: args.baseRef });

		return planningWorkflow({ task: args.task, repositoryPath, maxIterations: args.maxIterations });
	}
});

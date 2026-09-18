import { planningWorkflow } from "../planning/execute.ts";
import type { WorkflowResult } from "@vimhead.dev/norn";
import { developmentLoopScope } from "../../scope.ts";
import { developmentLoopArgsSchema } from "./schema.ts";
import { materializeWorkspaceRepository } from "./repository.ts";

export const developmentLoopWorkflow = developmentLoopScope.workflow({
	id: "developmentLoop",
	isEntrypoint: true,
	instructions: "Plan once, then loop implementation and review in a workspace repository copy. Call this when a repository task should run through planning, implementation, and review.",
	args: developmentLoopArgsSchema,
	async execute({ args, scope, run }): Promise<WorkflowResult> {
		const repositoryPath = await materializeWorkspaceRepository(run, scope.config.repositoryRoot, args.baseRef);

		return planningWorkflow({ task: args.task, repositoryPath, maxIterations: args.maxIterations });
	}
});

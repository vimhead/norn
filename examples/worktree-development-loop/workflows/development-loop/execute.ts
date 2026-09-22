import { planningWorkflow } from "../planning/execute.ts";
import type { WorkflowResult } from "@vimhead.dev/norn";
import { developmentLoopScope } from "../../scope.ts";
import { developmentLoopArgsSchema } from "./schema.ts";
import { materializeWorkspaceRepository } from "./repository.ts";

export const developmentLoopWorkflow = developmentLoopScope.workflow({
	name: "developmentLoop",
	entrypoint: {
		instructions: `Use when you want a repository task planned, implemented,
and reviewed in a separate clone with a caller approval gate. Starts from
committed content and retains changes for inspection without automatically
merging or pushing results back. Requires Git, Bash, and model access.`,
	},
	args: developmentLoopArgsSchema,
	async execute({ args, scope, paths, commands }): Promise<WorkflowResult> {
		const repositoryPath = await materializeWorkspaceRepository({
			commands,
			paths,
			repositoryRoot: scope.config.repositoryRoot,
			baseRef: args.baseRef,
		});

		return planningWorkflow({
			task: args.task,
			repositoryPath,
			maxIterations: args.maxIterations,
		});
	},
});

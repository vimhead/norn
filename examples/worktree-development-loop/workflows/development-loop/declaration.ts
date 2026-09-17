import type { NornWorkflowDefinition } from "@vimhead.dev/norn";
import { developmentLoopParamsSchema } from "./schema.ts";

export const developmentLoopWorkflow = {
	isEntrypoint: true,
	instructions: "Plan once, then loop implementation and review in a workspace repository copy. Call this when a repository task should run through planning, implementation, and review.",
	params: developmentLoopParamsSchema,
} as const satisfies NornWorkflowDefinition;

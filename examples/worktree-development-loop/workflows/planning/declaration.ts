import type { NornWorkflowDefinition } from "@vimhead.dev/norn";
import { planningParamsSchema } from "./schema.ts";

export const planningWorkflow = {
	isEntrypoint: false,
	instructions: "Create an implementation plan for a repository task.",
	params: planningParamsSchema,
} as const satisfies NornWorkflowDefinition;

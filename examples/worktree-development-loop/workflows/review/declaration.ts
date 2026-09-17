import type { NornWorkflowDefinition } from "@vimhead.dev/norn";
import { reviewParamsSchema } from "./schema.ts";

export const reviewWorkflow = {
	isEntrypoint: false,
	instructions: "Review the current repository boundary changes.",
	params: reviewParamsSchema,
} as const satisfies NornWorkflowDefinition;

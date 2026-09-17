import type { NornWorkflowDefinition } from "@vimhead.dev/norn";
import { implementationParamsSchema } from "./schema.ts";

export const implementationWorkflow = {
	isEntrypoint: false,
	instructions: "Apply one implementation pass in the current repository.",
	params: implementationParamsSchema,
} as const satisfies NornWorkflowDefinition;

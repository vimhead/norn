import { artifactRefSchema, type NornWorkflowPluginStateTree } from "@vimhead.dev/norn";
import { Type } from "typebox";
import { reviewDecisionSchema } from "./workflows/review/schema.ts";

export const developmentLoopState = {
	task: Type.String(),
	maxIterations: Type.Integer({ minimum: 1, maximum: 10 }),
	currentIteration: Type.Integer({ minimum: 1 }),
	repositoryPath: Type.String(),
} as const satisfies NornWorkflowPluginStateTree;

export const planningState = {
	planArtifact: artifactRefSchema,
} as const satisfies NornWorkflowPluginStateTree;

export const implementationState = {
	implementationSummary: Type.String(),
} as const satisfies NornWorkflowPluginStateTree;

export const reviewState = {
	reviewDecision: reviewDecisionSchema,
	reviewArtifact: artifactRefSchema,
} as const satisfies NornWorkflowPluginStateTree;

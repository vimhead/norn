import { artifactRefSchema } from "@vimhead.dev/norn";
import { Type, type StaticDecode } from "typebox";

export const reviewDecisionSchema = Type.Enum(["accept", "revise", "blocked"]);

export const reviewParamsSchema = Type.Object({
	task: Type.String(),
	iteration: Type.Integer({ minimum: 1 }),
});

export const reviewAgentResponseSchema = Type.Object({
	decision: reviewDecisionSchema,
	summary: Type.String(),
});

export const storedReviewSchema = Type.Object({
	decision: reviewDecisionSchema,
	summary: Type.String(),
	reviewArtifact: artifactRefSchema,
});

export type ReviewParams = StaticDecode<typeof reviewParamsSchema>;
export type StoredReview = StaticDecode<typeof storedReviewSchema>;

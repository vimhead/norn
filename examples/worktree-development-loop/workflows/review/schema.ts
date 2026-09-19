import { implementationArgsSchema } from "../implementation/schema.ts";
import { Type, type StaticDecode } from "typebox";

export const reviewDecisionSchema = Type.Enum(["accept", "revise", "blocked"]);

export const reviewArgsSchema = Type.Object({
	...implementationArgsSchema.properties,
	implementationSummary: Type.String(),
});

export const reviewAgentResponseSchema = Type.Object({
	decision: reviewDecisionSchema,
	summary: Type.String(),
});

export const storedReviewSchema = Type.Object({
	decision: reviewDecisionSchema,
	summary: Type.String(),
	reviewPath: Type.String(),
});

export type ReviewArgs = StaticDecode<typeof reviewArgsSchema>;
export type StoredReview = StaticDecode<typeof storedReviewSchema>;

import { implementationArgsSchema } from "../implementation/schema.ts";
import { Type, type StaticDecode } from "typebox";
import { reviewDecisionSchema } from "../review/schema.ts";

export const reviewRouterArgsSchema = Type.Object({
	...implementationArgsSchema.properties,
	decision: reviewDecisionSchema,
	summary: Type.String(),
	automatedReviewPath: Type.String(),
});

export type ReviewRouterArgs = StaticDecode<typeof reviewRouterArgsSchema>;

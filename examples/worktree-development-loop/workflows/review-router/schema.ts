import { artifactRefSchema } from "@vimhead.dev/norn";
import { Type, type StaticDecode } from "typebox";
import { reviewDecisionSchema } from "../review/schema.ts";

export const reviewRouterParamsSchema = Type.Object({
	iteration: Type.Integer({ minimum: 1 }),
	decision: reviewDecisionSchema,
	summary: Type.String(),
	automatedReviewArtifact: artifactRefSchema,
});

export type ReviewRouterParams = StaticDecode<typeof reviewRouterParamsSchema>;

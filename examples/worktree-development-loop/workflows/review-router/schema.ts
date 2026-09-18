import { implementationArgsSchema } from "../implementation/schema.ts";
import { artifactRefSchema } from "@vimhead.dev/norn";
import { Type, type StaticDecode } from "typebox";
import { reviewDecisionSchema } from "../review/schema.ts";

export const reviewRouterArgsSchema = Type.Object({
	...implementationArgsSchema.properties,
	decision: reviewDecisionSchema,
	summary: Type.String(),
	automatedReviewArtifact: artifactRefSchema,
});

export type ReviewRouterArgs = StaticDecode<typeof reviewRouterArgsSchema>;

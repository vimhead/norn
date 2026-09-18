import { artifactRefSchema } from "@vimhead.dev/norn";
import { planningArgsSchema } from "../planning/schema.ts";
import { Type, type StaticDecode } from "typebox";

export const implementationArgsSchema = Type.Object({
	...planningArgsSchema.properties,
	iteration: Type.Integer({ minimum: 1 }),
	planArtifact: artifactRefSchema,
	previousReviewArtifact: Type.Optional(artifactRefSchema),
});

export const implementationAgentResponseSchema = Type.Object({
	summary: Type.String(),
});

export type ImplementationArgs = StaticDecode<typeof implementationArgsSchema>;

import { planningArgsSchema } from "../planning/schema.ts";
import { Type, type StaticDecode } from "typebox";

export const implementationArgsSchema = Type.Object({
	...planningArgsSchema.properties,
	iteration: Type.Integer({ minimum: 1 }),
	planPath: Type.String(),
	previousReviewPath: Type.Optional(Type.String()),
});

export const implementationAgentResponseSchema = Type.Object({
	summary: Type.String(),
});

export type ImplementationArgs = StaticDecode<typeof implementationArgsSchema>;

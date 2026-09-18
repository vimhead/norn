import { Type, type StaticDecode } from "typebox";

export const implementationParamsSchema = Type.Object({
	task: Type.String(),
	iteration: Type.Integer({ minimum: 1 }),
});

export const implementationAgentResponseSchema = Type.Object({
	summary: Type.String(),
});

export type ImplementationParams = StaticDecode<typeof implementationParamsSchema>;

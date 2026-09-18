import { Type, type StaticDecode } from "typebox";

export const planningArgsSchema = Type.Object({
	task: Type.String(),
	repositoryPath: Type.String(),
	maxIterations: Type.Integer({ minimum: 1, maximum: 10 }),
});

export const planningAgentResponseSchema = Type.Object({
	plan: Type.String(),
	summary: Type.String(),
});

export type PlanningArgs = StaticDecode<typeof planningArgsSchema>;

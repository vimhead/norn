import { Type, type StaticDecode } from "typebox";

export const planningParamsSchema = Type.Object({
	task: Type.String(),
});

export const planningAgentResponseSchema = Type.Object({
	plan: Type.String(),
	summary: Type.String(),
});

export type PlanningParams = StaticDecode<typeof planningParamsSchema>;

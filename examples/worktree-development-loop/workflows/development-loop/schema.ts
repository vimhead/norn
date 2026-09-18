import { Type, type StaticDecode } from "typebox";

export const developmentLoopConfigSchema = Type.Object({
	repositoryRoot: Type.String(),
});

export const developmentLoopArgsSchema = Type.Object({
	task: Type.String(),
	baseRef: Type.String({ default: "HEAD" }),
	maxIterations: Type.Integer({ minimum: 1, maximum: 10, default: 3 }),
});

export type DevelopmentLoopConfig = StaticDecode<typeof developmentLoopConfigSchema>;
export type DevelopmentLoopArgs = StaticDecode<typeof developmentLoopArgsSchema>;

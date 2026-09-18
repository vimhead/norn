import { developmentLoopWorkflow } from "./workflows/development-loop/execute.ts";
import { planningWorkflow } from "./workflows/planning/execute.ts";
import { implementationWorkflow } from "./workflows/implementation/execute.ts";
import { reviewWorkflow } from "./workflows/review/execute.ts";
import { reviewRouterWorkflow } from "./workflows/review-router/execute.ts";

export default [developmentLoopWorkflow, planningWorkflow, implementationWorkflow, reviewWorkflow, reviewRouterWorkflow];

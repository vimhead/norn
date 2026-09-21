import { workflowScope } from "@vimhead.dev/norn";
import { developmentLoopConfigSchema } from "./workflows/development-loop/schema.ts";

export const developmentLoopScope = workflowScope({ name: "worktreeDevelopmentLoop", config: developmentLoopConfigSchema });

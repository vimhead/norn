import { join, resolve } from "node:path";

export function resolveNornAgentDirectory(input: { home: string; environment: NodeJS.ProcessEnv }): string {
	return resolve(input.environment.NORN_AGENT_DIR || join(input.home, ".norn", "agent"));
}

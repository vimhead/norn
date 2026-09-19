import { join } from "node:path";
import { SharedState } from "../../examples/shared-state/shared-state.ts";

export async function initializeSharedState(runRoot: string) {
	const path = join(runRoot, "current", "workspace", "state.sqlite");
	return { path, state: await SharedState.open({ path, create: true }) };
}

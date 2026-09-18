import { sharedState } from "../../examples/shared-state/shared-state.ts";
import { NornRunResources } from "../../packages/cli/src/resources.ts";

export async function initializeSharedState(runRoot: string) {
	const resources = await NornRunResources.initialize(runRoot);
	return { resources, state: await resources.ensure(sharedState) };
}

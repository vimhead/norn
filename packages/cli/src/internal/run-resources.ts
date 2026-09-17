import { join, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { NornRunResources } from "../resources.ts";
import { NornJsonWorkflowState } from "./state-store.ts";

export async function initializeRunResources(runRoot: string): Promise<{ readonly resources: NornRunResources; readonly state: NornJsonWorkflowState }> {
	const resources = await NornRunResources.initialize(runRoot);
	const state = await resources.ensure({
		name: "workflow-state",
		kind: "norn.state",
		configuration: { format: 1, path: "state.json" },
		async initialize({ files, mode }) {
			const state = new NornJsonWorkflowState({
				stateFile: join(resolve(runRoot), "current", "state.json"),
				files,
				coordinateMutation: withFileMutationQueue,
			});
			await state.initialize(mode);
			return state;
		},
	});
	return { resources, state };
}

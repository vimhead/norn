import type { Model } from "@earendil-works/pi-ai";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const offlineAgentModel: Model<"anthropic-messages"> = {
	id: "offline",
	name: "Offline test",
	provider: "offline-test",
	api: "anthropic-messages",
	baseUrl: "https://unused.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 128000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export const offlineAgentModels = [
	{ provider: offlineAgentModel.provider, id: offlineAgentModel.id },
] as const;

export async function configureOfflineAgentModel(input: {
	readonly agentDir: string;
}): Promise<void> {
	await writeFile(
		join(input.agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[offlineAgentModel.provider]: {
					api: offlineAgentModel.api,
					baseUrl: offlineAgentModel.baseUrl,
					apiKey: "offline-test-key",
					models: [offlineAgentModel],
				},
			},
		}),
	);
}

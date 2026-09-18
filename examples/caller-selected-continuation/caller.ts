import { definePlugin, definePluginManifest } from "@vimhead.dev/norn";
import { Type } from "typebox";
import { greetingContributionSchema } from "./producer.ts";

const deliveryParamsSchema = Type.Object({
	batchId: Type.String({ minLength: 1 }),
	...greetingContributionSchema.properties,
});

const callerManifest = definePluginManifest({
	id: "greetingConsumer",
	workflows: {
		saveJson: { isEntrypoint: false, params: deliveryParamsSchema },
		saveText: { isEntrypoint: false, params: deliveryParamsSchema },
	},
});

export default definePlugin(callerManifest, {
	workflows: {
		saveJson: {
			async execute(run, params) {
				const greeting = await run.artifacts.read(params.resultArtifact);
				const deliveryArtifact = await run.artifacts.write("delivery.json", JSON.stringify({
					batchId: params.batchId,
					summary: params.summary,
					greeting,
				}, null, 2));
				return run.complete({
					summary: params.summary,
					artifacts: { greeting: params.resultArtifact, delivery: deliveryArtifact },
					data: { batchId: params.batchId, format: "json" },
				});
			},
		},
		saveText: {
			async execute(run, params) {
				const greeting = await run.artifacts.read(params.resultArtifact);
				const deliveryArtifact = await run.artifacts.write("delivery.txt", `${params.batchId}: ${greeting}\n`);
				return run.complete({
					summary: params.summary,
					artifacts: { greeting: params.resultArtifact, delivery: deliveryArtifact },
					data: { batchId: params.batchId, format: "text" },
				});
			},
		},
	},
});

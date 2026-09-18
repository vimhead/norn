import { artifactRefSchema, definePlugin, definePluginManifest, workflowRefSchema } from "@vimhead.dev/norn";
import { Type } from "typebox";

export const greetingContributionSchema = Type.Object({
	resultArtifact: artifactRefSchema,
	summary: Type.String(),
});

export const producerManifest = definePluginManifest({
	id: "greetingProducer",
	workflows: {
		write: {
			isEntrypoint: true,
			instructions: "Write a greeting artifact for name, then invoke the caller-selected next workflow with resultArtifact and summary. The continuation owns completion; no model or external service is used.",
			params: Type.Object({
				name: Type.String({ minLength: 1 }),
				next: workflowRefSchema({ params: greetingContributionSchema }),
			}),
		},
	},
});

export default definePlugin(producerManifest, {
	workflows: {
		write: {
			async execute(run, params) {
				const resultArtifact = await run.artifacts.write("greeting.txt", `Hello, ${params.name}!`);
				return params.next({ resultArtifact, summary: `Greeting prepared for ${params.name}.` });
			},
		},
	},
});

import { definePlugin, definePluginManifest } from "norn";
import { z } from "zod";

export const manifest = definePluginManifest({
	id: "greeting",
	workflows: {
		write: {
			isEntrypoint: true,
			instructions: "Write a greeting artifact for the supplied name. Returns the greeting text and artifact reference; no agent or external service is used.",
			params: z.object({ name: z.string().trim().min(1) }),
		},
	},
});

export default definePlugin(manifest, {
	workflows: {
		write: {
			async execute(run, params) {
				const greeting = `Hello, ${params.name}!`;
				const greetingArtifact = await run.artifacts.write("greeting.txt", `${greeting}\n`);
				return run.complete({
					summary: greeting,
					artifacts: { greeting: greetingArtifact },
					data: { greeting },
				});
			},
		},
	},
});

import { definePlugin, definePluginManifest } from "@vimhead.dev/norn";
import { Type } from "typebox";

export const manifest = definePluginManifest({
	id: "greeting",
	workflows: {
		write: {
			isEntrypoint: true,
			instructions: "Write a greeting artifact for the supplied name. Returns the greeting text and artifact reference; no agent or external service is used.",
			params: Type.Object({ name: Type.Decode(Type.String({ pattern: "\\S" }), value => value.trim()) }),
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

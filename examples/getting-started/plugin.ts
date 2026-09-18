import { definePlugin, definePluginManifest } from "@vimhead.dev/norn";
import { Type } from "typebox";

const manifest = definePluginManifest({
	id: "summary",
	workflows: {
		write: {
			isEntrypoint: true,
			instructions: "Summarize supplied text and save the result.",
			params: Type.Object({ text: Type.String() }),
		},
	},
});

export default definePlugin(manifest, {
	workflows: {
		write: {
			async execute(run, { text }) {
				const summary = await run.agents.prompt({
					label: "summarize",
					tools: [],
					prompt: `Summarize this text in one sentence:\n${text}`,
					response: Type.Object({ text: Type.String() }),
				});
				const artifact = await run.artifacts.write("summary.txt", summary.text);
				return run.complete({ artifacts: { summary: artifact } });
			},
		},
	},
});

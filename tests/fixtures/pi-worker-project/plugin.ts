import { definePlugin, definePluginManifest } from "@vimhead.dev/norn";
import { z } from "zod";

const manifest = definePluginManifest({
	id: "provider",
	workflows: { check: { isEntrypoint: true, instructions: "Exercise a configured provider in a native worker.", params: z.object({}) } },
});

export default definePlugin(manifest, {
	workflows: {
		check: {
			async execute(run) {
				const result = await run.agents.prompt({ label: "check", tools: [], prompt: "Return ok", response: z.object({ ok: z.boolean() }), maxAttempts: 1 });
				const artifact = await run.artifacts.write("result.json", JSON.stringify(result));
				return run.complete({ artifacts: { result: artifact } });
			},
		},
	},
});

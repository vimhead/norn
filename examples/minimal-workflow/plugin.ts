import { workflow } from "@vimhead.dev/norn";
import { Type } from "typebox";

export const write = workflow({
	id: "greeting.write",
	isEntrypoint: true,
	instructions: "Write a greeting artifact for the supplied name. Returns the greeting text and artifact reference; no agent or external service is used.",
	args: Type.Object({ name: Type.Decode(Type.String({ pattern: "\\S" }), value => value.trim()) }),
	async execute({ args, run }) {
		const greeting = `Hello, ${args.name}!`;
		const greetingArtifact = await run.artifacts.write("greeting.txt", `${greeting}\n`);
		return run.complete({ summary: greeting, artifacts: { greeting: greetingArtifact }, data: { greeting } });
	},
});
export default [write];

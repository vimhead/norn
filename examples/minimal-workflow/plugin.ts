import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflow } from "@vimhead.dev/norn";
import { Type } from "typebox";

export const write = workflow({
	name: "greet",
	isEntrypoint: true,
	instructions: "Write a greeting file for the supplied name. Returns the greeting text and its workspace-relative greetingPath; no agent or external service is used.",
	args: Type.Object({ name: Type.Decode(Type.String({ pattern: "\\S" }), value => value.trim()) }),
	async execute({ args, paths, run }) {
		const greeting = `Hello, ${args.name}!`;
		const greetingPath = "greeting.txt";
		await writeFile(join(paths.workspace, greetingPath), `${greeting}\n`);
		return run.complete({ summary: greeting, data: { greeting, greetingPath } });
	},
});
export default [write];

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflow } from "@vimhead.dev/norn";
import { Type } from "typebox";

export const write = workflow({
	name: "greet",
	entrypoint: { instructions: "Use when you need a personalized greeting saved as a local file with no model or external service. Completes with the greeting text and workspace-relative file path." },
	args: Type.Object({ name: Type.Decode(Type.String({ pattern: "\\S" }), value => value.trim()) }),
	async execute({ args, paths, run }) {
		const greeting = `Hello, ${args.name}!`;
		const greetingPath = "greeting.txt";
		await writeFile(join(paths.workspace, greetingPath), `${greeting}\n`);
		return run.complete({ summary: greeting, data: { greeting, greetingPath } });
	},
});
export default [write];

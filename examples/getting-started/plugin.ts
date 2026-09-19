import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflow } from "@vimhead.dev/norn";
import { Type } from "typebox";

export const summarize = workflow({
	id: "summary.write",
	isEntrypoint: true,
	instructions: "Summarize supplied text and save the result.",
	args: Type.Object({ text: Type.String() }),
	async execute({ args, paths, run }) {
		const summary = await run.agents.prompt({
			label: "summarize",
			cwd: paths.workspace,
			tools: [],
			prompt: `Summarize this text in one sentence:\n${args.text}`,
			response: Type.Object({ text: Type.String() }),
		});
		const summaryPath = "summary.txt";
		await writeFile(join(paths.workspace, summaryPath), summary.text);
		return run.complete({ data: { summaryPath } });
	},
});
export default [summarize];

import { workflow } from "@vimhead.dev/norn";
import { Type } from "typebox";

export const summarize = workflow({
	id: "summary.write",
	isEntrypoint: true,
	instructions: "Summarize supplied text and save the result.",
	args: Type.Object({ text: Type.String() }),
	async execute({ args, run }) {
		const summary = await run.agents.prompt({
			label: "summarize",
			tools: [],
			prompt: `Summarize this text in one sentence:\n${args.text}`,
			response: Type.Object({ text: Type.String() }),
		});
		const artifact = await run.artifacts.write("summary.txt", summary.text);
		return run.complete({ artifacts: { summary: artifact } });
	},
});
export default [summarize];

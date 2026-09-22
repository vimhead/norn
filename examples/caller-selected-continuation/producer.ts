import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflowScope, workflowRefSchema } from "@vimhead.dev/norn";
import { Type } from "typebox";

export const greetingContributionSchema = Type.Object({
	resultPath: Type.String(),
	summary: Type.String(),
});

const scope = workflowScope({ name: "greetingProducer" });
export const write = scope.workflow({
	name: "write",
	entrypoint: {
		instructions:
			"Use when a later workflow needs a personalized greeting file and should decide what happens next. Passes the workspace-relative file path and summary to your continuation instead of completing the run.",
	},
	args: Type.Object({
		name: Type.String({ minLength: 1 }),
		next: workflowRefSchema({ args: greetingContributionSchema }),
	}),
	async execute({ args, paths }) {
		const resultPath = "greeting.txt";
		await writeFile(join(paths.workspace, resultPath), `Hello, ${args.name}!`);
		return args.next({
			resultPath,
			summary: `Greeting prepared for ${args.name}.`,
		});
	},
});

export default [write];

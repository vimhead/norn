import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflowScope, workflowRefSchema } from "@vimhead.dev/norn";
import { Type } from "typebox";

export const greetingContributionSchema = Type.Object({
	resultPath: Type.String(),
	summary: Type.String(),
});

const scope = workflowScope({ id: "greetingProducer" });
export const write = scope.workflow({
	id: "write",
	isEntrypoint: true,
	instructions: "Write a greeting file for name, then invoke the caller-selected next workflow with workspace-relative resultPath and summary. The continuation owns completion; no model or external service is used.",
	args: Type.Object({
		name: Type.String({ minLength: 1 }),
		next: workflowRefSchema({ args: greetingContributionSchema }),
	}),
	async execute({ args, paths }) {
		const resultPath = "greeting.txt";
		await writeFile(join(paths.workspace, resultPath), `Hello, ${args.name}!`);
		return args.next({ resultPath, summary: `Greeting prepared for ${args.name}.` });
	}
});

export default [write];

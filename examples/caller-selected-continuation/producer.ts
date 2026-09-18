import { artifactRefSchema, workflowScope, workflowRefSchema } from "@vimhead.dev/norn";
import { Type } from "typebox";

export const greetingContributionSchema = Type.Object({
	resultArtifact: artifactRefSchema,
	summary: Type.String(),
});

const scope = workflowScope({ id: "greetingProducer" });
export const write = scope.workflow({
	id: "write",
	isEntrypoint: true,
	instructions: "Write a greeting artifact for name, then invoke the caller-selected next workflow with resultArtifact and summary. The continuation owns completion; no model or external service is used.",
	args: Type.Object({
		name: Type.String({ minLength: 1 }),
		next: workflowRefSchema({ args: greetingContributionSchema }),
	}),
	async execute({ args, run }) {
		const resultArtifact = await run.artifacts.write("greeting.txt", `Hello, ${args.name}!`);
		return args.next({ resultArtifact, summary: `Greeting prepared for ${args.name}.` });
	}
});

export default [write];

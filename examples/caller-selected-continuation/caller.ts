import { workflowScope } from "@vimhead.dev/norn";
import { Type } from "typebox";
import { greetingContributionSchema } from "./producer.ts";

const deliveryArgsSchema = Type.Object({
	batchId: Type.String({ minLength: 1 }),
	...greetingContributionSchema.properties,
});

const scope = workflowScope({ id: "greetingConsumer" });
export const saveJson = scope.workflow({
	id: "saveJson",
	isEntrypoint: false,
	args: deliveryArgsSchema,
	async execute({ args, run }) {
		const greeting = await run.artifacts.read(args.resultArtifact);
		const deliveryArtifact = await run.artifacts.write("delivery.json", JSON.stringify({
			batchId: args.batchId,
			summary: args.summary,
			greeting,
		}, null, 2));
		return run.complete({
			summary: args.summary,
			artifacts: { greeting: args.resultArtifact, delivery: deliveryArtifact },
			data: { batchId: args.batchId, format: "json" },
		});
	}
});
export const saveText = scope.workflow({
	id: "saveText",
	isEntrypoint: false,
	args: deliveryArgsSchema,
	async execute({ args, run }) {
		const greeting = await run.artifacts.read(args.resultArtifact);
		const deliveryArtifact = await run.artifacts.write("delivery.txt", `${args.batchId}: ${greeting}\n`);
		return run.complete({
			summary: args.summary,
			artifacts: { greeting: args.resultArtifact, delivery: deliveryArtifact },
			data: { batchId: args.batchId, format: "text" },
		});
	}
});

export default [saveJson, saveText];

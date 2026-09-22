import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflowScope } from "@vimhead.dev/norn";
import { Type } from "typebox";
import { greetingContributionSchema } from "./producer.ts";

const deliveryArgsSchema = Type.Object({
	batchId: Type.String({ minLength: 1 }),
	...greetingContributionSchema.properties,
});

const scope = workflowScope({ name: "greetingConsumer" });
export const saveJson = scope.workflow({
	name: "saveJson",
	entrypoint: false,
	args: deliveryArgsSchema,
	async execute({ args, paths, run }) {
		const greeting = await readFile(
			join(paths.workspace, args.resultPath),
			"utf8",
		);
		const deliveryPath = "delivery.json";
		await writeFile(
			join(paths.workspace, deliveryPath),
			JSON.stringify(
				{
					batchId: args.batchId,
					summary: args.summary,
					greeting,
				},
				null,
				2,
			),
		);
		return run.complete({
			summary: args.summary,
			data: {
				batchId: args.batchId,
				format: "json",
				greetingPath: args.resultPath,
				deliveryPath,
			},
		});
	},
});
export const saveText = scope.workflow({
	name: "saveText",
	entrypoint: false,
	args: deliveryArgsSchema,
	async execute({ args, paths, run }) {
		const greeting = await readFile(
			join(paths.workspace, args.resultPath),
			"utf8",
		);
		const deliveryPath = "delivery.txt";
		await writeFile(
			join(paths.workspace, deliveryPath),
			`${args.batchId}: ${greeting}\n`,
		);
		return run.complete({
			summary: args.summary,
			data: {
				batchId: args.batchId,
				format: "text",
				greetingPath: args.resultPath,
				deliveryPath,
			},
		});
	},
});

export default [saveJson, saveText];

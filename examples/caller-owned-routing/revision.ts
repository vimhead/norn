import { workflow, workflowRefSchema } from "@vimhead.dev/norn";
import { Type } from "typebox";
import { headingSchema, outlineContributionSchema } from "./contracts.ts";

export const appendHeading = workflow({
	name: "appendHeading",
	entrypoint: {
		instructions: "Append one empty level-two Markdown section named heading to outline, then pass the revised outline to the caller-selected next workflow. Does not assess the outline or select further work; no model or external service is used.",
	},
	args: Type.Object({
		...outlineContributionSchema.properties,
		heading: headingSchema,
		next: workflowRefSchema({ args: outlineContributionSchema }),
	}),
	execute({ args }) {
		return args.next({ outline: `${args.outline.trimEnd()}\n\n## ${args.heading}\n` });
	},
});

export default [appendHeading];

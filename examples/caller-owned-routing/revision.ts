import { workflow, workflowRefSchema } from "@vimhead.dev/norn";
import { Type } from "typebox";
import { headingSchema, outlineContributionSchema } from "./contracts.ts";

export const appendHeading = workflow({
	name: "appendHeading",
	entrypoint: {
		instructions: "Use when a Markdown outline needs one additional empty section before further processing. Appends the requested level-two heading and passes the revised outline to your continuation; does not write section content or assess the result.",
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

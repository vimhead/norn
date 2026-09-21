import { workflow, workflowRefSchema } from "@vimhead.dev/norn";
import { Type } from "typebox";
import { assessmentContributionSchema, headingsSchema, outlineContributionSchema } from "./contracts.ts";

export const assessOutline = workflow({
	name: "assessOutline",
	entrypoint: {
		instructions: "Check an outline for exact, case-sensitive '## heading' lines from requiredHeadings. Pass outline, requiredHeadings, and missingHeadings to the caller-selected next workflow. Reports heading presence only, not content quality; no model or external service is used.",
	},
	args: Type.Object({
		...outlineContributionSchema.properties,
		requiredHeadings: headingsSchema,
		next: workflowRefSchema({ args: assessmentContributionSchema }),
	}),
	execute({ args }) {
		const lines = new Set(args.outline.split(/\r?\n/));
		const missingHeadings = args.requiredHeadings.filter(heading => !lines.has(`## ${heading}`));
		return args.next({ outline: args.outline, requiredHeadings: args.requiredHeadings, missingHeadings });
	},
});

export default [assessOutline];

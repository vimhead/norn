import { workflow, workflowRefSchema } from "@vimhead.dev/norn";
import { Type } from "typebox";
import {
	assessmentContributionSchema,
	headingsSchema,
	outlineContributionSchema,
} from "./contracts.ts";

export const assessOutline = workflow({
	name: "assessOutline",
	entrypoint: {
		instructions:
			"Use when you need to identify missing level-two headings in a Markdown outline before deciding whether to accept or revise it. Reports missing required headings to your continuation using exact, case-sensitive line matching; does not assess prose quality or decide acceptance.",
	},
	args: Type.Object({
		...outlineContributionSchema.properties,
		requiredHeadings: headingsSchema,
		next: workflowRefSchema({ args: assessmentContributionSchema }),
	}),
	execute({ args }) {
		const lines = new Set(args.outline.split(/\r?\n/));
		const missingHeadings = args.requiredHeadings.filter(
			(heading) => !lines.has(`## ${heading}`),
		);
		return args.next({
			outline: args.outline,
			requiredHeadings: args.requiredHeadings,
			missingHeadings,
		});
	},
});

export default [assessOutline];

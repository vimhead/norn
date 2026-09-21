import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflow, type WorkflowResult } from "@vimhead.dev/norn";
import { Type } from "typebox";
import { assessOutline } from "./assessment.ts";
import { assessmentContributionSchema } from "./contracts.ts";
import { appendHeading } from "./revision.ts";

export const routeAssessment = workflow({
	name: "routeAssessment",
	entrypoint: false,
	args: Type.Object({
		...assessmentContributionSchema.properties,
		maxMissingHeadings: Type.Integer({ minimum: 0 }),
		maxRevisions: Type.Integer({ minimum: 0, maximum: 100 }),
		revisionsUsed: Type.Integer({ minimum: 0, maximum: 100 }),
	}),
	async execute({ args, paths, run }): Promise<WorkflowResult> {
		const outlinePath = "outline.md";
		await writeFile(join(paths.workspace, outlinePath), args.outline);
		const data = { outlinePath, missingHeadings: args.missingHeadings, revisionsUsed: args.revisionsUsed };
		if (args.missingHeadings.length <= args.maxMissingHeadings) {
			return run.complete({ summary: "Outline meets the caller's heading threshold.", data });
		}
		if (args.revisionsUsed >= args.maxRevisions) {
			return run.fail({ summary: "Revision limit reached before the outline met the caller's heading threshold.", data });
		}
		return appendHeading({
			outline: args.outline,
			heading: args.missingHeadings[0],
			next: {
				workflow: assessOutline.id,
				forwardArgs: {
					requiredHeadings: args.requiredHeadings,
					next: {
						workflow: routeAssessment.id,
						forwardArgs: {
							maxMissingHeadings: args.maxMissingHeadings,
							maxRevisions: args.maxRevisions,
							revisionsUsed: args.revisionsUsed + 1,
						},
					},
				},
			},
		});
	},
});

export default [routeAssessment];

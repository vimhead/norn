import type { NornRegisteredWorkflowInfo } from "@vimhead.dev/norn";
import { NornProjectNotFoundError } from "./internal/errors.ts";
import { loadNornProject } from "./workflow-loader.ts";

export async function loadNornWorkflowsIntro(cwd: string): Promise<string> {
	try {
		const project = await loadNornProject(cwd);
		return renderNornWorkflowsIntro(project.registry.list());
	} catch (error) {
		if (error instanceof NornProjectNotFoundError) return "";
		throw error;
	}
}

export function renderNornWorkflowsIntro(
	workflows: readonly NornRegisteredWorkflowInfo[],
): string {
	const entrypoints = workflows.filter((workflow) => workflow.isEntrypoint);
	if (entrypoints.length === 0) return "";
	return [
		"The following Norn workflows are available in the current project.",
		"When a task matches, use `workflows inspect <id>` with the runtime specified above to load its current contract.",
		"Use `workflows list` to refresh this snapshot after workflow changes.",
		"",
		"<available_norn_workflows>",
		...entrypoints.flatMap((workflow) => [
			"  <workflow>",
			`    <id>${escapeXml(workflow.id)}</id>`,
			`    <instructions>${escapeXml(workflow.instructions ?? "")}</instructions>`,
			"  </workflow>",
		]),
		"</available_norn_workflows>",
	].join("\n");
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

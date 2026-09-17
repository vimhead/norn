import type { NornPluginDiagnostic } from "@vimhead.dev/norn";

export class NornProjectLoadError extends Error {
	readonly code = "NORN_PROJECT_INVALID";
	readonly isComplete = false;
	readonly diagnostics: readonly NornPluginDiagnostic[];

	constructor(input: { readonly diagnostics: readonly NornPluginDiagnostic[] }) {
		const details = input.diagnostics.map(diagnostic =>
			`${diagnostic.stage}: ${diagnostic.pluginPath} (declared in ${diagnostic.configPath}${diagnostic.workflowId ? `; workflow ${diagnostic.workflowId}` : ""}): ${diagnostic.message}`,
		);
		super(`Norn project is incomplete (${input.diagnostics.length} diagnostics); execution is blocked.\n${details.join("\n")}`);
		this.name = "NornProjectLoadError";
		this.diagnostics = input.diagnostics;
	}
}

export class NornRunStoppedError extends Error {
	constructor() {
		super("Stopped by user");
		this.name = "NornRunStoppedError";
	}
}

export function zodErrorMessage(error: unknown): string {
	const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> }).issues;
	if (!Array.isArray(issues) || issues.length === 0) return errorMessage(error);
	return issues
		.slice(0, 3)
		.map((issue) => {
			const path = Array.isArray(issue.path) && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
			return `${path}${issue.message ?? "Invalid workflow response"}`;
		})
		.join("; ");
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

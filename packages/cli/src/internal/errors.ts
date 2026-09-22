import type { NornWorkflowDiagnostic } from "@vimhead.dev/norn";
import { AssertError } from "typebox/value";

export class NornProjectLoadError extends Error {
	readonly code = "NORN_PROJECT_INVALID";
	readonly isComplete = false;
	readonly diagnostics: readonly NornWorkflowDiagnostic[];

	constructor(input: {
		readonly diagnostics: readonly NornWorkflowDiagnostic[];
	}) {
		const details = input.diagnostics.map(
			(diagnostic) =>
				`${diagnostic.stage}: ${diagnostic.modulePath} (declared in ${diagnostic.configPath}${diagnostic.workflowId ? `; workflow ${diagnostic.workflowId}` : ""}): ${diagnostic.message}`,
		);
		super(
			`Norn project is incomplete (${input.diagnostics.length} diagnostics); execution is blocked.\n${details.join("\n")}`,
		);
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

export function schemaErrorMessage(error: AssertError): string {
	return error.cause.errors
		.slice(0, 3)
		.map((issue) => `${issue.instancePath || "/"}: ${issue.message}`)
		.join("; ");
}

export function errorMessage(error: unknown): string {
	if (error instanceof AssertError) return schemaErrorMessage(error);
	return error instanceof Error ? error.message : String(error);
}

import type { NornDocumentationLocation } from "./documentation.ts";

export function renderNornDocumentationIntro(input: {
	readonly documentation: NornDocumentationLocation;
	readonly invocation: readonly [string, ...string[]];
}): string {
	const { documentation, invocation } = input;
	return [
		"# Norn",
		"Norn supports reusable TypeScript workflows, native agent workers, saved results, and recoverable transitions. Capabilities can be authored, exercised, repaired, and reused during a task; Norn is optional.",
		"",
		`Runtime argv (JSON array; CLI arguments follow these entries): ${JSON.stringify(invocation)}`,
		`Version: ${JSON.stringify(documentation.version)}; build commit: ${documentation.commit === null ? "unknown" : JSON.stringify(documentation.commit)}`,
		"",
		`Documentation index and topic routing: ${JSON.stringify(documentation.paths.index)}`,
		`Main README: ${JSON.stringify(documentation.paths.readme)}`,
		`Documentation directory: ${JSON.stringify(documentation.paths.docs)}`,
		`Runnable examples: ${JSON.stringify(documentation.paths.examples)}`,
		`Task-time guidance (skill): ${JSON.stringify(documentation.paths.skill)}`,
		"Relative documentation links resolve from the containing file, not the task's working directory.",
		"",
		"| Rule | GOOD | BAD |",
		"|---|---|---|",
		"| IF authoring or repairing a Norn capability, THEN read the index and relevant linked documentation/examples. ELSE leave unrelated documentation unloaded. | Read the worker reference before creating a worker. | Guess the API or load every manual upfront. |",
		"",
		"Live CLI contracts (argument arrays appended to the runtime argv above):",
		'- ["workflows", "list"] — currently registered entrypoints.',
		'- ["workflows", "inspect", "<workflow-id>"] — current instructions, params schema, and source.',
		'- ["help"] — command usage.',
	].join("\n");
}

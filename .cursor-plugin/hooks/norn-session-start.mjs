import { loadHostIntroduction } from "../../packages/core/src/host-introduction.mjs";
import { RuntimeResolutionError } from "../../packages/core/src/runtime-resolution.mjs";

try {
	const additional_context = await loadHostIntroduction({
		executableOverride: process.env.NORN_EXECUTABLE || null,
		cwd:
			process.env.CURSOR_PROJECT_DIR ||
			process.env.CLAUDE_PROJECT_DIR ||
			process.cwd(),
	});
	process.stdout.write(`${JSON.stringify({ additional_context })}\n`);
} catch (error) {
	process.stderr.write(
		`Norn introduction unavailable.${error instanceof RuntimeResolutionError ? ` ${error.message}` : ""} Check NORN_EXECUTABLE or .nornrc.json and run the selected runtime with 'docs intro' and 'workflows intro' in the project directory to diagnose, then start a new Cursor session to retry.\n`,
	);
	process.stdout.write("{}\n");
}

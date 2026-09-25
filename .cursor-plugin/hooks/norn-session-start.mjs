import { loadHostIntroduction } from "../../packages/core/src/host-introduction.mjs";

try {
	const additional_context = await loadHostIntroduction({
		executable: process.env.NORN_EXECUTABLE || "norn",
		cwd:
			process.env.CURSOR_PROJECT_DIR ||
			process.env.CLAUDE_PROJECT_DIR ||
			process.cwd(),
	});
	process.stdout.write(`${JSON.stringify({ additional_context })}\n`);
} catch {
	process.stderr.write(
		"Norn introduction unavailable. Check NORN_EXECUTABLE and run that executable with 'docs intro' and 'workflows intro' in the project directory to diagnose, then start a new Cursor session to retry.\n",
	);
	process.stdout.write("{}\n");
}

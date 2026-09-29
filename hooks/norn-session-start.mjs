import { loadHostIntroduction } from "../packages/core/src/host-introduction.mjs";
import { RuntimeResolutionError } from "../packages/core/src/runtime-resolution.mjs";

async function readSessionStart() {
	let input = "";
	for await (const chunk of process.stdin) {
		input += chunk;
		if (Buffer.byteLength(input, "utf8") > 65_536)
			throw new Error("Oversized session input");
	}
	const session = JSON.parse(input);
	if (
		!session ||
		typeof session !== "object" ||
		session.hook_event_name !== "SessionStart" ||
		typeof session.cwd !== "string" ||
		!session.cwd ||
		typeof session.source !== "string"
	)
		throw new Error("Invalid session input");
	return session;
}

async function deliverIntroduction() {
	const session = await readSessionStart();
	if (
		session.agent_id !== undefined ||
		session.agent_type !== undefined ||
		!["startup", "clear", "compact"].includes(session.source)
	)
		return;
	const additionalContext = await loadHostIntroduction({
		executableOverride: process.env.NORN_EXECUTABLE || null,
		cwd: session.cwd,
	});
	if (additionalContext.length > 10_000)
		throw new Error("Introduction exceeds Claude Code context limit");
	process.stdout.write(
		`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } })}\n`,
	);
}

try {
	await deliverIntroduction();
} catch (error) {
	process.stderr.write(
		`Norn introduction unavailable.${error instanceof RuntimeResolutionError ? ` ${error.message}` : ""} Check NORN_EXECUTABLE or .nornrc.json and run the selected runtime with 'docs intro' and 'workflows intro' in the project directory to diagnose; check the combined introduction fits Claude Code's 10000-character hook limit, then start a new Claude Code session to retry.\n`,
	);
	process.exitCode = 1;
}

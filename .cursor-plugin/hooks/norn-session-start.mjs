import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { promisify } from "node:util";

const runExecutable = promisify(execFile);
const INTRO_START = "<norn-docs-intro>";
const INTRO_END = "</norn-docs-intro>";
const MAX_INTRO_BYTES = 16_384;

function selectedExecutable() {
	const executable = process.env.NORN_EXECUTABLE;
	return executable === undefined || executable.length === 0
		? "norn"
		: executable;
}

function projectDirectory() {
	return (
		process.env.CURSOR_PROJECT_DIR ||
		process.env.CLAUDE_PROJECT_DIR ||
		process.cwd()
	);
}

function readIntroResponse(stdout) {
	const response = JSON.parse(stdout);
	if (
		!response ||
		typeof response !== "object" ||
		typeof response.intro !== "string"
	)
		throw new Error("Invalid Norn introduction response");
	if (
		response.intro.trim().length === 0 ||
		Buffer.byteLength(response.intro, "utf8") > MAX_INTRO_BYTES
	)
		throw new Error("Invalid Norn introduction response");
	return response.intro;
}

function writeResponse(response) {
	process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function loadNornIntroduction() {
	const { stdout } = await runExecutable(
		selectedExecutable(),
		["docs", "intro"],
		{
			cwd: projectDirectory(),
			timeout: 10_000,
			maxBuffer: MAX_INTRO_BYTES * 2,
		},
	);
	return readIntroResponse(stdout);
}

try {
	const intro = await loadNornIntroduction();
	writeResponse({
		additional_context: `${INTRO_START}\n${intro}\n${INTRO_END}`,
	});
} catch {
	process.stderr.write(
		"Norn introduction unavailable. Check NORN_EXECUTABLE and run that executable with 'docs intro' to diagnose, then start a new Cursor session to retry.\n",
	);
	writeResponse({});
}

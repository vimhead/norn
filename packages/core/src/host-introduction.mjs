import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { promisify } from "node:util";

const runExecutable = promisify(execFile);
const MAX_INTRO_BYTES = 16_384;

function readIntroResponse({ stdout, group }) {
	const response = JSON.parse(stdout);
	if (
		!response ||
		typeof response !== "object" ||
		typeof response.intro !== "string" ||
		(group === "docs" && response.intro.trim().length === 0) ||
		Buffer.byteLength(response.intro, "utf8") > MAX_INTRO_BYTES
	)
		throw new Error("Invalid Norn introduction response");
	return response.intro;
}

async function loadIntroduction({ executable, cwd, group }) {
	const { stdout } = await runExecutable(executable, [group, "intro"], {
		cwd,
		timeout: 10_000,
		maxBuffer: MAX_INTRO_BYTES * 2,
	});
	return readIntroResponse({ stdout, group });
}

export async function loadHostIntroduction({ executable, cwd }) {
	const [intro, workflowsIntro] = await Promise.all([
		loadIntroduction({ executable, cwd, group: "docs" }),
		loadIntroduction({ executable, cwd, group: "workflows" }),
	]);
	return `<norn-docs-intro>\n${intro}\n</norn-docs-intro>${workflowsIntro ? `\n\n${workflowsIntro}` : ""}`;
}

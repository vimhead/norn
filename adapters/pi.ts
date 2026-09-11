import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGENT_RESPONSE_TOOL_NAME } from "../src/internal/agent-response-tool.ts";

const INTRO_START = "<norn-docs-intro>";
const INTRO_END = "</norn-docs-intro>";

export default function nornPiAdapter(pi: ExtensionAPI): void {
	let wasUnavailable = false;
	let cachedIntro: { executable: string; intro: string } | undefined;

	pi.registerFlag("norn-executable", {
		type: "string",
		description: "Norn executable for docs intro (defaults to norn on PATH). Accepts an executable path, not a shell command.",
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (pi.getAllTools().some(tool => tool.name === AGENT_RESPONSE_TOOL_NAME)) return;
		if (event.systemPrompt.includes(INTRO_START)) return;

		try {
			const configuredExecutable = pi.getFlag("norn-executable");
			if (configuredExecutable !== undefined && typeof configuredExecutable !== "string") throw new Error("Invalid Norn executable flag");
			const executable = configuredExecutable ?? "norn";
			if (cachedIntro?.executable !== executable) {
				cachedIntro = undefined;
				const result = await pi.exec(executable, ["docs", "intro"], { cwd: ctx.cwd, timeout: 10_000 });
				if (result.killed || result.code !== 0) throw new Error("Norn docs intro did not complete successfully");
				const response: unknown = JSON.parse(result.stdout);
				if (!response || typeof response !== "object" || !("intro" in response) || typeof response.intro !== "string" || response.intro.trim().length === 0 || Buffer.byteLength(response.intro, "utf8") > 16_384) {
					throw new Error("Invalid Norn introduction response");
				}
				cachedIntro = { executable, intro: response.intro };
			}
			wasUnavailable = false;
			return { systemPrompt: `${event.systemPrompt}\n\n${INTRO_START}\n${cachedIntro.intro}\n${INTRO_END}` };
		} catch {
			cachedIntro = undefined;
			if (!wasUnavailable) ctx.ui.notify("Norn introduction unavailable. Check --norn-executable and run that executable with 'docs intro' to diagnose.", "warning");
			wasUnavailable = true;
			return;
		}
	});
}

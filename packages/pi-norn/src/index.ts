import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGENT_RESPONSE_TOOL_NAME } from "@vimhead.dev/norn-core/agent-protocol";
import {
	resolveNornRuntime,
	RuntimeResolutionError,
	type NornRuntimeInvocation,
} from "@vimhead.dev/norn-core/runtime-resolution";

const INTRO_START = "<norn-docs-intro>";
const INTRO_END = "</norn-docs-intro>";

export default function nornPiAdapter(pi: ExtensionAPI): void {
	let cachedIntro:
		| {
				configuredExecutable: string | undefined;
				cwd: string;
				isProjectTrusted: boolean;
				intro: string;
				workflowsIntro: string;
		  }
		| undefined;

	pi.registerFlag("norn-executable", {
		type: "string",
		description:
			"Norn executable override for docs intro and workflows intro (otherwise uses trusted .nornrc.json, then norn on PATH). Accepts an executable path, not a shell command.",
	});

	pi.on("session_start", async (_event, ctx) => {
		cachedIntro = undefined;
		if (pi.getAllTools().some((tool) => tool.name === AGENT_RESPONSE_TOOL_NAME))
			return;

		try {
			const configuredExecutable = pi.getFlag("norn-executable");
			if (
				configuredExecutable !== undefined &&
				typeof configuredExecutable !== "string"
			)
				throw new Error("Invalid Norn executable flag");
			const isProjectTrusted = ctx.isProjectTrusted();
			const invocation = await resolveNornRuntime({
				cwd: ctx.cwd,
				executableOverride: configuredExecutable ?? null,
				isProjectTrusted,
				nodeExecutable: process.versions.bun ? "node" : process.execPath,
			});
			const [intro, workflowsIntro] = await Promise.all([
				loadIntroduction({ pi, invocation, cwd: ctx.cwd, group: "docs" }),
				isProjectTrusted
					? loadIntroduction({
							pi,
							invocation,
							cwd: ctx.cwd,
							group: "workflows",
						})
					: Promise.resolve(""),
			]);
			cachedIntro = {
				configuredExecutable,
				cwd: ctx.cwd,
				isProjectTrusted,
				intro,
				workflowsIntro,
			};
		} catch (error) {
			ctx.ui.notify(
				`Norn introduction unavailable.${error instanceof RuntimeResolutionError ? ` ${error.message}` : ""} Check --norn-executable or .nornrc.json and run the selected runtime with 'docs intro' and 'workflows intro' in the project directory to diagnose, then /reload to retry.`,
				"warning",
			);
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!cachedIntro) return;
		if (pi.getAllTools().some((tool) => tool.name === AGENT_RESPONSE_TOOL_NAME))
			return;
		if (event.systemPrompt.includes(INTRO_START)) return;
		if (
			cachedIntro.configuredExecutable !== pi.getFlag("norn-executable") ||
			cachedIntro.cwd !== ctx.cwd ||
			cachedIntro.isProjectTrusted !== ctx.isProjectTrusted()
		) {
			cachedIntro = undefined;
			ctx.ui.notify(
				"Norn runtime selection or project trust changed. Run /reload to refresh its introduction.",
				"warning",
			);
			return;
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n${INTRO_START}\n${cachedIntro.intro}\n${INTRO_END}${cachedIntro.workflowsIntro ? `\n\n${cachedIntro.workflowsIntro}` : ""}`,
		};
	});
}

async function loadIntroduction(input: {
	readonly pi: ExtensionAPI;
	readonly invocation: NornRuntimeInvocation;
	readonly cwd: string;
	readonly group: "docs" | "workflows";
}): Promise<string> {
	const result = await input.pi.exec(
		input.invocation.executable,
		[...input.invocation.args, input.group, "intro"],
		{ cwd: input.cwd, timeout: 10_000 },
	);
	if (result.killed || result.code !== 0)
		throw new Error(`Norn ${input.group} intro did not complete successfully`);
	const response: unknown = JSON.parse(result.stdout);
	if (
		!response ||
		typeof response !== "object" ||
		!("intro" in response) ||
		typeof response.intro !== "string" ||
		(input.group === "docs" && response.intro.trim().length === 0) ||
		Buffer.byteLength(response.intro, "utf8") > 16_384
	) {
		throw new Error("Invalid Norn introduction response");
	}
	return response.intro;
}

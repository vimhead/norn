import assert from "node:assert/strict";
import {
	createAssistantMessageEventStream,
	getCurrentTools,
	type AssistantMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	getDocsPath,
	getPackageDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

function renderLastPrompt(context: TranscriptContext): string {
	const message = context.messages
		.filter((message) => message.role === "user")
		.at(-1);
	if (!message) return "";
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
}

export default function registerOfflineProvider(pi: ExtensionAPI): void {
	pi.registerProvider("norn-offline", {
		name: "Norn Offline",
		baseUrl: "https://unused.invalid",
		api: "openai-completions",
		models: [
			{
				id: "fixture",
				name: "Fixture",
				reasoning: false,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 4096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			const prompt = renderLastPrompt(context);
			const responseTool = getCurrentTools(context.messages).find(
				(tool) => tool.name === "pi_workflows_agent_response",
			);
			const runId = prompt.match(/Pass runId exactly as: (.+)/)?.[1] ?? null;
			const label = prompt.match(/Pass label exactly as: (.+)/)?.[1] ?? null;
			if (responseTool) assert.ok(runId && label);
			const message: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: responseTool
					? [
							{
								type: "toolCall",
								id: "offline-response",
								name: responseTool.name,
								arguments: {
									runId,
									label,
									response: { ok: true },
								},
							},
						]
					: [
							{
								type: "text",
								text: JSON.stringify({
									prompt,
									cwd: process.cwd(),
									docs: getDocsPath(),
									packageRoot: getPackageDir(),
								}),
							},
						],
				stopReason: responseTool ? "toolUse" : "stop",
				timestamp: Date.now(),
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			stream.push({
				type: "done",
				reason: responseTool ? "toolUse" : "stop",
				message,
			});
			stream.end();
			return stream;
		},
	});
}

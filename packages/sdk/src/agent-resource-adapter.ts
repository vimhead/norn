import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export type NornAgentResourceBinding = {
	readonly tools: readonly ToolDefinition[];
	dispose(): Promise<void>;
};

export type NornAgentResourceAdapter = {
	readonly name: string;
	bind(context: { readonly runId: string; readonly label: string }): Promise<NornAgentResourceBinding>;
};

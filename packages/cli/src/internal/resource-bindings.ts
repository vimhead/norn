import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { NornAgentResourceBinding, NornAgentResourceAdapter } from "@vimhead.dev/norn";

export class NornSessionResourceBindings {
	readonly tools: ToolDefinition[] = [];
	private readonly bindings: NornAgentResourceBinding[] = [];

	async bind(input: { readonly adapters: readonly NornAgentResourceAdapter[]; readonly runId: string; readonly label: string; readonly reservedTools: readonly string[] }): Promise<void> {
		const adapterNames = new Set<string>();
		const tools = new Set(input.reservedTools);
		for (const adapter of input.adapters) {
			if (adapterNames.has(adapter.name)) throw new Error(`Duplicate resource adapter: ${adapter.name}`);
			adapterNames.add(adapter.name);
			const binding = await adapter.bind({ runId: input.runId, label: input.label });
			this.bindings.push(binding);
			for (const tool of binding.tools) {
				if (tools.has(tool.name)) throw new Error(`Resource tool name collision: ${tool.name}`);
				tools.add(tool.name);
				this.tools.push(tool);
			}
		}
	}

	async dispose(): Promise<void> {
		const errors: unknown[] = [];
		for (const binding of this.bindings.splice(0).reverse()) {
			try {
				await binding.dispose();
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length) throw new AggregateError(errors, "Resource binding cleanup failed");
	}
}

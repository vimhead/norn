import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { NornResourceBinding, NornResourceFamily } from "../resources.ts";

export class NornSessionResourceBindings {
	readonly tools: ToolDefinition[] = [];
	private readonly bindings: NornResourceBinding[] = [];

	async bind(input: { readonly families: readonly NornResourceFamily[]; readonly runId: string; readonly label: string; readonly reservedTools: readonly string[] }): Promise<void> {
		const families = new Set<string>();
		const tools = new Set(input.reservedTools);
		for (const family of input.families) {
			if (families.has(family.name)) throw new Error(`Duplicate resource family: ${family.name}`);
			families.add(family.name);
			const binding = await family.bind({ runId: input.runId, label: input.label });
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

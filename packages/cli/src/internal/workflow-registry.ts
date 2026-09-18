import { isWorkflowComplete, isWorkflowFail, isWorkflowNext, type NornAnyWorkflowDeclaration, type NornDispose, type NornInspectedWorkflowInfo, type NornRegisteredWorkflowInfo, type NornRunComplete, type NornRunFail, type NornRunFor, type NornRunNext, type NornWorkflowGateInfo, type NornWorkflowImplementation, type NornWorkflowParams, type NornWorkflowPluginInfo } from "@vimhead.dev/norn";
import { assertWorkflowMetadata, inspectSchema, isPlainObject, schemaShape, schemaType, unwrapSchema } from "@vimhead.dev/norn/schema";
import { type TSchema } from "typebox";
import { Value } from "typebox/value";

export type NornRegisteredWorkflow = {
	workflow: NornAnyWorkflowDeclaration;
	implementation: NornWorkflowImplementation<NornAnyWorkflowDeclaration, unknown>;
	configuration?: NornRegisteredConfiguration;
	plugin?: NornWorkflowPluginInfo;
};

export type NornRegisteredConfiguration = { readonly schema: TSchema; readonly input: unknown; readonly value: unknown };

export function decodePluginConfiguration(input: { readonly pluginId: string; readonly schema: TSchema | undefined; readonly value: unknown }): NornRegisteredConfiguration | undefined {
	if (!input.schema) {
		if (input.value !== undefined) throw new Error(`Norn config provided for plugin without config schema: ${input.pluginId}`);
		return undefined;
	}
	const value = defaultConfigInput(input.schema, input.value);
	return { schema: input.schema, input: value, value: Value.Decode(input.schema, value) };
}

export type NornWorkflowStepResult =
	| NornRunNext
	| { readonly type: "complete"; readonly workflow: NornAnyWorkflowDeclaration; readonly metadata?: NornRunComplete["metadata"] }
	| { readonly type: "fail"; readonly workflow: NornAnyWorkflowDeclaration; readonly metadata: NornRunFail["metadata"] };

export class NornWorkflowRegistry {
	private readonly entries = new Map<string, NornRegisteredWorkflow>();

	register<TWorkflow extends NornAnyWorkflowDeclaration>(
		workflow: TWorkflow,
		implementation: NornWorkflowImplementation<TWorkflow, unknown>,
		metadata: { readonly plugin?: NornWorkflowPluginInfo; readonly configuration?: NornRegisteredConfiguration } = {},
	): NornDispose {
		if (this.entries.has(workflow.id)) throw new Error(`Workflow already registered: ${workflow.id}`);

		const entry: NornRegisteredWorkflow = {
			workflow,
			implementation: implementation as NornWorkflowImplementation<NornAnyWorkflowDeclaration, unknown>,
			configuration: metadata.configuration,
			plugin: metadata.plugin,
		};
		assertWorkflowMetadata(workflow);
		assertGateWorkflow(workflow);
		this.entries.set(workflow.id, entry);

		return () => {
			if (this.entries.get(workflow.id) === entry) this.entries.delete(workflow.id);
		};
	}

	list(options: { readonly entrypointsOnly?: boolean } = {}): NornRegisteredWorkflowInfo[] {
		const entries = options.entrypointsOnly ? this.launchableEntries() : this.sortedEntries();
		return entries.map((entry) => workflowInfo(entry));
	}

	inspect(workflowId: string): NornInspectedWorkflowInfo | undefined {
		const entry = this.entries.get(workflowId);
		return entry ? inspectedWorkflowInfo(entry) : undefined;
	}

	launchableEntries(): NornRegisteredWorkflow[] {
		return this.sortedEntries().filter(({ workflow }) => workflow.isEntrypoint);
	}

	workflowById(workflowId: string): NornAnyWorkflowDeclaration | undefined {
		return this.entries.get(workflowId)?.workflow;
	}

	async describeGate<TWorkflow extends NornAnyWorkflowDeclaration>(
		workflow: TWorkflow,
		run: NornRunFor<TWorkflow>,
		params: unknown,
		configOverride?: unknown,
	): Promise<string> {
		const entry = this.entries.get(workflow.id);
		if (!entry) throw new Error(`Unknown workflow: ${workflow.id}`);
		if (!workflow.gate) throw new Error(`Workflow is not gated: ${workflow.id}`);
		const parsedParams = Value.Decode(workflow.params, params) as NornWorkflowParams<TWorkflow>;
		const parsedConfig = parseExecutionConfig(entry, configOverride);
		const description = await (entry.implementation as NornWorkflowImplementation<TWorkflow, unknown>).gate?.describe(run, parsedParams, parsedConfig);
		return validateGateDescription(description ?? workflow.id, workflow.id);
	}

	async execute<TWorkflow extends NornAnyWorkflowDeclaration>(
		workflow: TWorkflow,
		run: NornRunFor<TWorkflow>,
		params: unknown,
		configOverride?: unknown,
	): Promise<NornWorkflowStepResult> {
		const entry = this.entries.get(workflow.id);
		if (!entry) throw new Error(`Unknown workflow: ${workflow.id}`);

		const parsedParams = Value.Decode(workflow.params, params) as NornWorkflowParams<TWorkflow>;
		const parsedConfig = parseExecutionConfig(entry, configOverride);
		const result = await (entry.implementation as NornWorkflowImplementation<TWorkflow, unknown>).execute(run, parsedParams, parsedConfig);
		if (isWorkflowNext(result)) return result;
		if (isWorkflowComplete(result)) return { type: "complete", workflow, metadata: result.metadata };
		if (isWorkflowFail(result)) return { type: "fail", workflow, metadata: result.metadata };
		throw new Error(`Workflow returned invalid control result: ${workflow.id}`);
	}

	private sortedEntries(): NornRegisteredWorkflow[] {
		return Array.from(this.entries.values()).sort((left, right) => left.workflow.id.localeCompare(right.workflow.id));
	}
}

function defaultConfigInput(configSchema: TSchema, config: unknown): unknown {
	if (config !== undefined) return config;
	return schemaType(unwrapSchema(configSchema)) === "object" ? {} : undefined;
}

function parseExecutionConfig(entry: NornRegisteredWorkflow, configOverride: unknown): unknown {
	const pluginConfigOverride = pluginConfigOverrideInput(entry, configOverride);
	if (!entry.configuration) {
		if (pluginConfigOverride !== undefined) throw new Error(`Run config override provided for plugin without config schema: ${entry.plugin?.id ?? entry.workflow.id}`);
		return undefined;
	}
	if (pluginConfigOverride === undefined) return entry.configuration.value;
	const rawConfig = isPlainObject(entry.configuration.input) && isPlainObject(pluginConfigOverride)
		? deepMerge(entry.configuration.input, pluginConfigOverride)
		: pluginConfigOverride;
	return Value.Decode(entry.configuration.schema, rawConfig);
}

function pluginConfigOverrideInput(entry: NornRegisteredWorkflow, configOverride: unknown): unknown {
	if (configOverride === undefined) return undefined;
	if (!isPlainObject(configOverride)) throw new Error("Run config override must be an object keyed by plugin id");
	const pluginId = entry.plugin?.id;
	return pluginId ? configOverride[pluginId] : undefined;
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const baseValue = result[key];
		result[key] = isPlainObject(baseValue) && isPlainObject(value) ? deepMerge(baseValue, value) : value;
	}
	return result;
}

function assertGateWorkflow(workflow: NornAnyWorkflowDeclaration): void {
	if (!workflow.gate) return;
	if (workflow.gate.enabled !== true) throw new Error(`Workflow gate must be enabled with true: ${workflow.id}`);
	if (!workflow.gate.fields) return;
	const paramsSchema = unwrapSchema(workflow.params);
	if (schemaType(paramsSchema) !== "object") throw new Error(`Workflow gate fields require object params: ${workflow.id}`);
	const paramsShape = schemaShape(paramsSchema);
	for (const field of workflow.gate.fields) {
		if (!Object.prototype.hasOwnProperty.call(paramsShape, field)) throw new Error(`Unknown workflow gate field ${field}: ${workflow.id}`);
	}
}

function validateGateDescription(description: string, workflowId: string): string {
	const trimmed = description.trim();
	if (trimmed.length === 0) throw new Error(`Workflow gate description must not be empty: ${workflowId}`);
	return trimmed;
}

function inspectedWorkflowInfo(entry: NornRegisteredWorkflow): NornInspectedWorkflowInfo {
	return {
		...workflowInfo(entry),
		paramsSchema: inspectSchema(entry.workflow.params),
		gate: gateInfo(entry.workflow),
	};
}

function workflowInfo(entry: NornRegisteredWorkflow): NornRegisteredWorkflowInfo {
	return {
		id: entry.workflow.id,
		instructions: entry.workflow.instructions,
		isEntrypoint: entry.workflow.isEntrypoint,
		isolation: entry.workflow.isolation,
		plugin: entry.plugin,
	};
}

function gateInfo(workflow: NornAnyWorkflowDeclaration): NornWorkflowGateInfo | null {
	return workflow.gate ? { enabled: true, fields: workflow.gate.fields } : null;
}

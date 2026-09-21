import { isWorkflowComplete, isWorkflowDeclaration, isWorkflowFail, isWorkflowNext, type NornAnyWorkflowDeclaration, type NornDispose, type NornInspectedWorkflowInfo, type NornRegisteredWorkflowInfo, type NornRunComplete, type NornRunFail, type NornRunNext, type NornWorkflowPaths, type NornWorkflowContext, type NornWorkflowGateInfo, type NornWorkflowSource, type NornWorkflowScopeInfo, type NornProjectConfigurationInfo } from "@vimhead.dev/norn";
import { assertWorkflowMetadata, inspectSchema, isPlainObject, schemaShape, schemaType, unwrapSchema } from "@vimhead.dev/norn/schema";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

export type NornRegisteredConfiguration = { readonly key: string; readonly schema: TSchema | undefined; readonly input: unknown; readonly value: unknown };
export type NornRegisteredWorkflow = {
	readonly workflow: NornAnyWorkflowDeclaration;
	readonly configuration: NornRegisteredConfiguration;
	readonly scopeId: string | undefined;
	readonly source: NornWorkflowSource | undefined;
};

type NornRegisteredScope = { readonly definition: NornWorkflowScopeInfo; readonly configuration: NornRegisteredConfiguration };

export function decodeConfiguration(input: { readonly key: string; readonly schema: TSchema | undefined; readonly value: unknown }): NornRegisteredConfiguration {
	if (!input.schema) {
		if (input.value !== undefined) throw new Error(`Norn config provided without config schema: ${input.key}`);
		return { key: input.key, schema: undefined, input: undefined, value: undefined };
	}
	const value = input.value === undefined && schemaType(unwrapSchema(input.schema)) === "object" ? {} : input.value;
	return { key: input.key, schema: input.schema, input: value, value: Value.Decode(input.schema, value) };
}

export function assertCompatibleConfigurationOwners(workflows: readonly NornAnyWorkflowDeclaration[]): void {
	const owners = new Map<string, { readonly kind: "workflow" | "scope"; readonly definition: object }>();
	for (const workflow of workflows) {
		for (const owner of [
			{ key: workflow.id, kind: "workflow" as const, definition: workflow },
			...(workflow.scope ? [{ key: workflow.scope.id, kind: "scope" as const, definition: workflow.scope }] : []),
		]) {
			const previous = owners.get(owner.key);
			if (previous && previous.kind !== owner.kind) throw new Error(`Ambiguous configuration key: ${owner.key}`);
			if (previous && owner.kind === "scope" && previous.definition !== owner.definition) throw new Error(`Duplicate workflow scope id: ${owner.key}; import one shared scope definition`);
			owners.set(owner.key, owner);
		}
	}
}

export type NornWorkflowStepResult =
	| NornRunNext
	| { readonly type: "complete"; readonly workflow: NornAnyWorkflowDeclaration; readonly metadata?: NornRunComplete["metadata"] }
	| { readonly type: "fail"; readonly workflow: NornAnyWorkflowDeclaration; readonly metadata: NornRunFail["metadata"] };

type NornExecutionContextInput = {
	readonly execution: Pick<NornWorkflowContext, "run" | "agents" | "commands" | "logs">;
	readonly paths: NornWorkflowPaths;
	readonly args: unknown;
	readonly configOverride: unknown;
};

type NornWorkflowExecutionInput = NornExecutionContextInput & { readonly workflow: NornAnyWorkflowDeclaration };

export class NornWorkflowRegistry {
	private readonly entries = new Map<string, NornRegisteredWorkflow>();
	private readonly scopes = new Map<string, NornRegisteredScope>();

	register(input: { readonly workflow: NornAnyWorkflowDeclaration; readonly config: Readonly<Record<string, unknown>>; readonly source: NornWorkflowSource | undefined }): NornDispose {
		const { workflow, config, source } = input;
		assertWorkflowDefinition(workflow);
		if (this.entries.has(workflow.id)) throw new Error(`Workflow already registered: ${workflow.id}`);
		assertCompatibleConfigurationOwners([...this.sortedEntries().map(entry => entry.workflow), workflow]);
		const entry: NornRegisteredWorkflow = {
			workflow, source, scopeId: workflow.scope?.id,
			configuration: decodeConfiguration({ key: workflow.id, schema: workflow.config, value: configurationInput(config, workflow.id) }),
		};
		if (workflow.scope && !this.scopes.has(workflow.scope.id)) {
			this.scopes.set(workflow.scope.id, {
				definition: workflow.scope,
				configuration: decodeConfiguration({ key: workflow.scope.id, schema: workflow.scope.config, value: configurationInput(config, workflow.scope.id) }),
			});
		}
		this.entries.set(workflow.id, entry);
		return () => {
			if (this.entries.get(workflow.id) !== entry) return;
			this.entries.delete(workflow.id);
			if (entry.scopeId && ![...this.entries.values()].some(other => other.scopeId === entry.scopeId)) this.scopes.delete(entry.scopeId);
		};
	}

	list(options: { readonly entrypointsOnly?: boolean } = {}): NornRegisteredWorkflowInfo[] {
		return (options.entrypointsOnly ? this.launchableEntries() : this.sortedEntries()).map(workflowInfo);
	}

	inspect(workflowId: string): NornInspectedWorkflowInfo | undefined {
		const entry = this.entries.get(workflowId);
		const scope = entry?.scopeId ? this.scopes.get(entry.scopeId) : undefined;
		return entry ? {
			...workflowInfo(entry),
			argsSchema: inspectSchema(entry.workflow.args),
			configSchema: entry.configuration.schema ? inspectSchema(entry.configuration.schema) : null,
			scope: scope ? {
				id: scope.definition.id,
				configKey: scope.configuration.key,
				configSchema: scope.configuration.schema ? inspectSchema(scope.configuration.schema) : null,
			} : undefined,
			gate: gateInfo(entry.workflow),
		} : undefined;
	}

	configurationInfos(): NornProjectConfigurationInfo[] {
		return [
			...this.sortedEntries().map(entry => ({ configuration: entry.configuration, scopeId: null })),
			...[...this.scopes.values()].map(scope => ({ configuration: scope.configuration, scopeId: scope.definition.id })),
		].map(({ configuration, scopeId }) => ({ key: configuration.key, scopeId, configSchema: configuration.schema ? inspectSchema(configuration.schema) : null, config: configuration.value }));
	}

	launchableEntries(): NornRegisteredWorkflow[] { return this.sortedEntries().filter(({ workflow }) => workflow.entrypoint !== false); }
	workflowById(workflowId: string): NornAnyWorkflowDeclaration | undefined { return this.entries.get(workflowId)?.workflow; }

	async describeGate(input: NornWorkflowExecutionInput): Promise<string> {
		const { workflow } = input;
		const entry = this.requireEntry(workflow.id);
		if (!workflow.gate) throw new Error(`Workflow is not gated: ${workflow.id}`);
		const context = this.createExecutionContext({ ...input, entry });
		const description = await entry.workflow.gate?.describe?.(context) ?? workflow.id;
		if (typeof description !== "string" || description.trim().length === 0) throw new Error(`Workflow gate description must not be empty: ${workflow.id}`);
		return description.trim();
	}

	async execute(input: NornWorkflowExecutionInput): Promise<NornWorkflowStepResult> {
		const { workflow } = input;
		const entry = this.requireEntry(workflow.id);
		const result = await entry.workflow.execute(this.createExecutionContext({ ...input, entry }));
		if (isWorkflowNext(result)) return result;
		if (isWorkflowComplete(result)) return { type: "complete", workflow, metadata: result.metadata };
		if (isWorkflowFail(result)) return { type: "fail", workflow, metadata: result.metadata };
		throw new Error(`Workflow returned invalid control result: ${workflow.id}`);
	}

	private createExecutionContext(input: NornExecutionContextInput & { readonly entry: NornRegisteredWorkflow }): NornWorkflowContext {
		const { entry, execution, paths, configOverride } = input;
		const scope = entry.scopeId ? this.scopes.get(entry.scopeId) : undefined;
		return {
			args: Value.Decode(entry.workflow.args, input.args),
			config: parseExecutionConfig(entry.configuration, configOverride),
			...(scope ? { scope: { id: scope.definition.id, config: parseExecutionConfig(scope.configuration, configOverride) } } : {}),
			paths,
			run: execution.run,
			agents: execution.agents,
			commands: execution.commands,
			logs: execution.logs,
		};
	}

	private requireEntry(id: string): NornRegisteredWorkflow {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Unknown workflow: ${id}`);
		return entry;
	}
	private sortedEntries(): NornRegisteredWorkflow[] { return [...this.entries.values()].sort((left, right) => left.workflow.id.localeCompare(right.workflow.id)); }
}

function configurationInput(config: Readonly<Record<string, unknown>>, key: string): unknown {
	return Object.hasOwn(config, key) ? config[key] : undefined;
}

function parseExecutionConfig(configuration: NornRegisteredConfiguration, overrides: unknown): unknown {
	if (overrides !== undefined && !isPlainObject(overrides)) throw new Error("Run config override must be an object keyed by workflow or scope id");
	const override = overrides ? configurationInput(overrides, configuration.key) : undefined;
	if (override === undefined) return configuration.value;
	if (!configuration.schema) throw new Error(`Run config override provided without config schema: ${configuration.key}`);
	const input = isPlainObject(configuration.input) && isPlainObject(override) ? deepMerge(configuration.input, override) : override;
	return Value.Decode(configuration.schema, input);
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };
	for (const [key, value] of Object.entries(override)) result[key] = isPlainObject(result[key]) && isPlainObject(value) ? deepMerge(result[key], value) : value;
	return result;
}

export function assertWorkflowDefinition(workflow: NornAnyWorkflowDeclaration): void {
	assertWorkflowMetadata(workflow);
	if (!isWorkflowDeclaration(workflow)) throw new Error("Invalid workflow definition");
	assertGateWorkflow(workflow);
}

function assertGateWorkflow(workflow: NornAnyWorkflowDeclaration): void {
	if (!workflow.gate) return;
	if (workflow.gate.enabled !== true) throw new Error(`Workflow gate must be enabled with true: ${workflow.id}`);
	if (workflow.gate.describe !== undefined && typeof workflow.gate.describe !== "function") throw new Error(`Invalid gate description callback: ${workflow.id}`);
	if (!workflow.gate.fields) return;
	const argsSchema = unwrapSchema(workflow.args);
	if (schemaType(argsSchema) !== "object") throw new Error(`Workflow gate fields require object args: ${workflow.id}`);
	const shape = schemaShape(argsSchema);
	for (const field of workflow.gate.fields) if (!Object.hasOwn(shape, field)) throw new Error(`Unknown workflow gate field ${field}: ${workflow.id}`);
}

function workflowInfo(entry: NornRegisteredWorkflow): NornRegisteredWorkflowInfo {
	return {
		id: entry.workflow.id,
		instructions: entry.workflow.entrypoint === false ? undefined : entry.workflow.entrypoint.instructions,
		isEntrypoint: entry.workflow.entrypoint !== false,
		source: entry.source,
		configKey: entry.workflow.id,
		scope: entry.scopeId ? { id: entry.scopeId } : undefined,
	};
}
function gateInfo(workflow: NornAnyWorkflowDeclaration): NornWorkflowGateInfo | null {
	return workflow.gate ? { enabled: true, fields: workflow.gate.fields } : null;
}

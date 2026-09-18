import type { NornWorkflowState, NornWorkflowStateDefinition } from "@vimhead.dev/norn";
import { writeJsonAtomically } from "@vimhead.dev/norn-core/atomic-files";
import { isNodeError } from "@vimhead.dev/norn-core/errors";
import type { NornFileCoordinator } from "@vimhead.dev/norn/files";
import { jsonValueSchema } from "@vimhead.dev/norn/schema";
import { readFile } from "node:fs/promises";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

function copyStateValue<Schema extends TSchema>(schema: Schema, value: unknown): Static<Schema> {
	Value.Assert(jsonValueSchema, value);
	return structuredClone(Value.Parse(schema, value));
}

export class NornMemoryWorkflowState implements NornWorkflowState {
	private readonly data = new Map<string, unknown>();

	async get<Schema extends TSchema>(state: NornWorkflowStateDefinition<Schema>): Promise<Static<Schema>> {
		const value = await this.getOptional(state);
		if (value === undefined) throw new Error(`Missing workflow state: ${state.id}`);
		return value;
	}

	async getOptional<Schema extends TSchema>(state: NornWorkflowStateDefinition<Schema>): Promise<Static<Schema> | undefined> {
		if (!this.data.has(state.id)) return undefined;
		return copyStateValue(state.schema, this.data.get(state.id));
	}

	async set<Schema extends TSchema>(state: NornWorkflowStateDefinition<Schema>, value: NoInfer<Static<Schema>>): Promise<void> {
		this.data.set(state.id, copyStateValue(state.schema, value));
	}
}

export class NornJsonWorkflowState implements NornWorkflowState {
	readonly stateFile: string;

	constructor(private readonly input: {
		readonly stateFile: string;
		readonly files: NornFileCoordinator;
		readonly coordinateMutation: <T>(path: string, operation: () => Promise<T>) => Promise<T>;
	}) {
		this.stateFile = input.stateFile;
	}

	async initialize(mode: "create" | "open"): Promise<void> {
		await this.input.files.withExclusiveLock(this.stateFile, async (path) => {
			try {
				await this.readStateFile(path);
			} catch (error) {
				if (mode !== "create" || !isNodeError(error) || error.code !== "ENOENT") throw error;
				await writeJsonAtomically(path, {});
			}
		});
	}

	async get<Schema extends TSchema>(state: NornWorkflowStateDefinition<Schema>): Promise<Static<Schema>> {
		const value = await this.getOptional(state);
		if (value === undefined) throw new Error(`Missing workflow state: ${state.id}`);
		return value;
	}

	async getOptional<Schema extends TSchema>(state: NornWorkflowStateDefinition<Schema>): Promise<Static<Schema> | undefined> {
		const data = await this.input.files.withExclusiveLock(this.stateFile, (path) => this.readStateFile(path));
		if (!Object.prototype.hasOwnProperty.call(data, state.id)) return undefined;
		return copyStateValue(state.schema, data[state.id]);
	}

	async set<Schema extends TSchema>(state: NornWorkflowStateDefinition<Schema>, value: NoInfer<Static<Schema>>): Promise<void> {
		const parsedValue = copyStateValue(state.schema, value);
		await this.input.coordinateMutation(this.stateFile, () => this.input.files.withExclusiveLock(this.stateFile, async (path) => {
			const data = await this.readStateFile(path);
			Object.defineProperty(data, state.id, { value: parsedValue, enumerable: true, configurable: true, writable: true });
			await writeJsonAtomically(path, data);
		}));
	}

	private async readStateFile(path: string): Promise<Record<string, unknown>> {
		const content = await readFile(path, "utf8");
		const parsed = JSON.parse(content) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		throw new Error(`Invalid workflow state document: ${path}`);
	}
}

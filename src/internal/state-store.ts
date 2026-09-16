import { readFile } from "node:fs/promises";
import type { NornWorkflowStateDefinition, NornWorkflowState } from "../api.ts";
import type { NornFileCoordinator } from "../files.ts";
import { isNodeError } from "./errors.ts";
import { writeJsonAtomically } from "./json-file.ts";

export class NornMemoryWorkflowState implements NornWorkflowState {
	private readonly data = new Map<string, unknown>();

	async get<T>(state: NornWorkflowStateDefinition<T>): Promise<T> {
		const value = await this.getOptional(state);
		if (value === undefined) throw new Error(`Missing workflow state: ${state.id}`);
		return value;
	}

	async getOptional<T>(state: NornWorkflowStateDefinition<T>): Promise<T | undefined> {
		if (!this.data.has(state.id)) return undefined;
		return state.schema.parse(this.data.get(state.id));
	}

	async set<T>(state: NornWorkflowStateDefinition<T>, value: T): Promise<void> {
		this.data.set(state.id, state.schema.parse(value));
	}
}

export class NornJsonWorkflowState implements NornWorkflowState {
	constructor(readonly stateFile: string, private readonly files: NornFileCoordinator) {}

	async initialize(mode: "create" | "open"): Promise<void> {
		await this.files.withExclusiveLock(this.stateFile, async (path) => {
			try {
				await this.readStateFile(path);
			} catch (error) {
				if (mode !== "create" || !isNodeError(error) || error.code !== "ENOENT") throw error;
				await writeJsonAtomically(path, {});
			}
		});
	}

	async get<T>(state: NornWorkflowStateDefinition<T>): Promise<T> {
		const value = await this.getOptional(state);
		if (value === undefined) throw new Error(`Missing workflow state: ${state.id}`);
		return value;
	}

	async getOptional<T>(state: NornWorkflowStateDefinition<T>): Promise<T | undefined> {
		const data = await this.files.withExclusiveLock(this.stateFile, (path) => this.readStateFile(path));
		if (!Object.prototype.hasOwnProperty.call(data, state.id)) return undefined;
		return state.schema.parse(data[state.id]);
	}

	async set<T>(state: NornWorkflowStateDefinition<T>, value: T): Promise<void> {
		const parsedValue = state.schema.parse(value);
		await this.files.withExclusiveLock(this.stateFile, async (path) => {
			const data = await this.readStateFile(path);
			Object.defineProperty(data, state.id, { value: parsedValue, enumerable: true, configurable: true, writable: true });
			await writeJsonAtomically(path, data);
		});
	}

	private async readStateFile(path: string): Promise<Record<string, unknown>> {
		const content = await readFile(path, "utf8");
		const parsed = JSON.parse(content) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		throw new Error(`Invalid workflow state document: ${path}`);
	}
}

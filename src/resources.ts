import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { createRunFileCoordinator, type NornFileCoordinator } from "./files.ts";
import { isNodeError } from "./internal/errors.ts";
import { writeJsonAtomically } from "./internal/json-file.ts";
import { NornJsonWorkflowState } from "./internal/state-store.ts";

export type NornResourceContext = {
	readonly mode: "create" | "open";
	readonly directory: string;
	readonly files: NornFileCoordinator;
};

export type NornResourceDefinition<T> = {
	readonly name: string;
	readonly kind: string;
	readonly configuration: z.infer<ReturnType<typeof z.json>>;
	initialize(context: NornResourceContext): Promise<T>;
};

export type NornResourceBinding = {
	readonly tools: readonly ToolDefinition[];
	dispose(): Promise<void>;
};

export type NornResourceFamily = {
	readonly name: string;
	bind(context: { readonly runId: string; readonly label: string }): Promise<NornResourceBinding>;
};

const definitionSchema = z.strictObject({ name: z.string(), kind: z.string().min(1), configuration: z.json() });
const recordSchema = definitionSchema.extend({ isInitialized: z.boolean() });

export class NornRunResources {
	readonly files: NornFileCoordinator;
	readonly state: NornJsonWorkflowState;
	private readonly entries = new Map<string, { readonly definition: z.output<typeof definitionSchema>; readonly value: Promise<unknown> }>();

	private constructor(private readonly runRoot: string) {
		this.files = createRunFileCoordinator(runRoot);
		this.state = new NornJsonWorkflowState(join(runRoot, "current", "state.json"), this.files);
	}

	static async initialize(runRoot: string): Promise<NornRunResources> {
		const resources = new NornRunResources(resolve(runRoot));
		await resources.ensure({
			name: "workflow-state",
			kind: "norn.state",
			configuration: { format: 1, path: "state.json" },
			initialize: async ({ mode }) => {
				await resources.state.initialize(mode);
				return resources.state;
			},
		});
		return resources;
	}

	async ensure<T>(definition: NornResourceDefinition<T>): Promise<T> {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(definition.name)) throw new Error(`Invalid resource name: ${definition.name}`);
		const identity = definitionSchema.parse({ name: definition.name, kind: definition.kind, configuration: definition.configuration });
		const existing = this.entries.get(definition.name);
		if (existing) {
			if (!isDeepStrictEqual(existing.definition, identity)) throw new Error(`Incompatible resource definition: ${definition.name}`);
			return existing.value as Promise<T>;
		}
		const value = this.initializeResource(definition, identity);
		const entry = { definition: identity, value };
		this.entries.set(definition.name, entry);
		try {
			return await value;
		} catch (error) {
			if (this.entries.get(definition.name) === entry) this.entries.delete(definition.name);
			throw error;
		}
	}

	private async initializeResource<T>(definition: NornResourceDefinition<T>, identity: z.output<typeof definitionSchema>): Promise<T> {
		const directory = join(this.runRoot, "current", "resources", definition.name);
		await mkdir(directory, { recursive: true });
		return this.files.withExclusiveLock(join(directory, "definition.json"), async (path) => {
			let stored: z.output<typeof recordSchema> | undefined;
			try {
				stored = recordSchema.parse(JSON.parse(await readFile(path, "utf8")));
			} catch (error) {
				if (!isNodeError(error) || error.code !== "ENOENT") throw error;
			}
			if (stored) {
				const { isInitialized: _isInitialized, ...storedIdentity } = stored;
				if (!isDeepStrictEqual(storedIdentity, identity)) throw new Error(`Incompatible resource definition: ${definition.name}`);
			} else {
				await writeJsonAtomically(path, { ...identity, isInitialized: false });
			}
			const value = await definition.initialize({ directory, files: this.files, mode: stored?.isInitialized ? "open" : "create" });
			if (!stored?.isInitialized) await writeJsonAtomically(path, { ...identity, isInitialized: true });
			return value;
		});
	}
}

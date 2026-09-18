import type { NornResourceDefinition, NornResources } from "@vimhead.dev/norn";
import { writeJsonAtomically } from "@vimhead.dev/norn-core/atomic-files";
import { isNodeError } from "@vimhead.dev/norn-core/errors";
import { createRunFileCoordinator, type NornFileCoordinator } from "@vimhead.dev/norn/files";
import { jsonValueSchema } from "@vimhead.dev/norn/schema";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Type, type StaticDecode } from "typebox";
import { Value } from "typebox/value";

const definitionSchema = Type.Object({ name: Type.String(), kind: Type.String({ minLength: 1 }), configuration: jsonValueSchema }, { additionalProperties: false });
const recordSchema = Type.Object({ ...definitionSchema.properties, isInitialized: Type.Boolean() }, { additionalProperties: false });

export class NornRunResources implements NornResources {
	readonly files: NornFileCoordinator;
	private readonly entries = new Map<string, { readonly definition: StaticDecode<typeof definitionSchema>; readonly value: Promise<unknown> }>();

	private constructor(private readonly runRoot: string) {
		this.files = createRunFileCoordinator(runRoot);
	}

	static async initialize(runRoot: string): Promise<NornRunResources> {
		const resources = new NornRunResources(resolve(runRoot));
		await mkdir(join(resources.runRoot, "current", "resources"), { recursive: true });
		return resources;
	}

	async ensure<T>(definition: NornResourceDefinition<T>): Promise<T> {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(definition.name)) throw new Error(`Invalid resource name: ${definition.name}`);
		const identity = structuredClone(Value.Parse(definitionSchema, { name: definition.name, kind: definition.kind, configuration: definition.configuration }));
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

	private async initializeResource<T>(definition: NornResourceDefinition<T>, identity: StaticDecode<typeof definitionSchema>): Promise<T> {
		const directory = join(this.runRoot, "current", "resources", definition.name);
		await mkdir(directory, { recursive: true });
		return this.files.withExclusiveLock(join(directory, "definition.json"), async (path) => {
			let stored: StaticDecode<typeof recordSchema> | undefined;
			try {
				stored = Value.Parse(recordSchema, JSON.parse(await readFile(path, "utf8")));
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

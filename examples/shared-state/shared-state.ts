import type { NornFileCoordinator, NornResourceDefinition } from "@vimhead.dev/norn";
import { jsonValueSchema } from "@vimhead.dev/norn/schema";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

export type SharedStateField<Schema extends TSchema = TSchema> = { readonly id: string; readonly schema: Schema };
export type SharedStateAccess = Pick<SharedState, "get" | "getOptional" | "set">;

export class SharedState {
	readonly stateFile: string;
	constructor(private readonly input: { readonly path: string; readonly files: NornFileCoordinator }) { this.stateFile = input.path; }

	async initialize(mode: "create" | "open"): Promise<void> {
		await this.input.files.withExclusiveLock(this.stateFile, async path => {
			try { await this.readDocument(path); }
			catch (error) {
				if (mode !== "create" || !(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
				await this.writeDocument(path, {});
			}
		});
	}
	async get<Schema extends TSchema>(field: SharedStateField<Schema>): Promise<Static<Schema>> {
		const value = await this.getOptional(field);
		if (value === undefined) throw new Error(`Missing shared state: ${field.id}`);
		return value;
	}
	async getOptional<Schema extends TSchema>(field: SharedStateField<Schema>): Promise<Static<Schema> | undefined> {
		return this.input.files.withExclusiveLock(this.stateFile, async path => {
			const document = await this.readDocument(path);
			return Object.hasOwn(document, field.id) ? copyValue(field.schema, document[field.id]) : undefined;
		});
	}
	async set<Schema extends TSchema>(field: SharedStateField<Schema>, value: NoInfer<Static<Schema>>): Promise<void> {
		const checked = copyValue(field.schema, value);
		await this.input.files.withExclusiveLock(this.stateFile, async path => {
			const document = await this.readDocument(path);
			Object.defineProperty(document, field.id, { value: checked, enumerable: true, configurable: true, writable: true });
			await this.writeDocument(path, document);
		});
	}
	private async readDocument(path: string): Promise<Record<string, unknown>> {
		const document: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error(`Invalid shared state document: ${path}`);
		return document as Record<string, unknown>;
	}
	private async writeDocument(path: string, document: Record<string, unknown>): Promise<void> {
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify(document), { flag: "wx", mode: 0o600 });
			await rename(temporary, path);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EEXIST") throw error;
			try { await rm(temporary, { force: true }); }
			catch (cleanupError) { throw new AggregateError([error, cleanupError], "Shared state write and cleanup failed"); }
			throw error;
		}
	}
}
function copyValue<Schema extends TSchema>(schema: Schema, value: unknown): Static<Schema> {
	Value.Assert(jsonValueSchema, value);
	return structuredClone(Value.Parse(schema, value));
}
export const sharedState: NornResourceDefinition<SharedState> = {
	name: "shared-state",
	kind: "example.shared-state",
	configuration: { format: 1 },
	async initialize({ directory, files, mode }) {
		const state = new SharedState({ path: join(directory, "state.json"), files });
		await state.initialize(mode);
		return state;
	},
};

import { jsonValueSchema } from "@vimhead.dev/norn/schema";
import { access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

export type SharedStateField<Schema extends TSchema = TSchema> = { readonly id: string; readonly schema: Schema };
export type SharedStateAccess = Pick<SharedState, "get" | "getOptional" | "set">;

export class SharedState {
	private isClosed = false;
	private constructor(private readonly database: DatabaseSync) {}

	static async open(input: { readonly path: string; readonly create: boolean }): Promise<SharedState> {
		if (input.create) await mkdir(dirname(input.path), { recursive: true });
		else await access(input.path);
		const database = new DatabaseSync(input.path);
		try {
			database.exec("PRAGMA busy_timeout = 30000; PRAGMA journal_mode = DELETE;");
			if (input.create) database.exec("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
			database.prepare("SELECT key, value FROM state LIMIT 0").all();
			return new SharedState(database);
		} catch (error) {
			database.close();
			throw error;
		}
	}

	async get<Schema extends TSchema>(field: SharedStateField<Schema>): Promise<Static<Schema>> {
		const value = await this.getOptional(field);
		if (value === undefined) throw new Error(`Missing shared state: ${field.id}`);
		return value;
	}

	async getOptional<Schema extends TSchema>(field: SharedStateField<Schema>): Promise<Static<Schema> | undefined> {
		const row = this.database.prepare("SELECT value FROM state WHERE key = ?").get(field.id);
		return row === undefined ? undefined : copyValue(field.schema, JSON.parse(String(row.value)));
	}

	async set<Schema extends TSchema>(field: SharedStateField<Schema>, value: NoInfer<Static<Schema>>): Promise<void> {
		const checked = copyValue(field.schema, value);
		this.database.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(field.id, JSON.stringify(checked));
	}

	close(): void {
		if (this.isClosed) return;
		this.database.close();
		this.isClosed = true;
	}
}

function copyValue<Schema extends TSchema>(schema: Schema, value: unknown): Static<Schema> {
	Value.Assert(jsonValueSchema, value);
	return structuredClone(Value.Parse(schema, value));
}

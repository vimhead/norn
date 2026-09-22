import { access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { Type, type StaticDecode } from "typebox";
import { Value } from "typebox/value";

export const noteSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 128 }),
		text: Type.String({ minLength: 5, maxLength: 1000 }),
	},
	{ additionalProperties: false },
);
export const summarySchema = Type.Object(
	{
		summary: Type.String({ minLength: 1, maxLength: 240 }),
		quote: Type.String({ minLength: 5, maxLength: 240 }),
	},
	{ additionalProperties: false },
);
type Note = StaticDecode<typeof noteSchema>;
export type Summary = StaticDecode<typeof summarySchema>;
const leaseSchema = Type.Object(
	{
		owner: Type.String({ minLength: 1, maxLength: 128 }),
		token: Type.String({ format: "uuid" }),
		expiresAt: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
const recordSchema = Type.Union([
	Type.Object(
		{
			...noteSchema.properties,
			status: Type.Literal("available"),
			deliveries: Type.Integer({ minimum: 0 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...noteSchema.properties,
			status: Type.Literal("leased"),
			deliveries: Type.Integer({ exclusiveMinimum: 0 }),
			lease: leaseSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...noteSchema.properties,
			status: Type.Literal("acknowledged"),
			deliveries: Type.Integer({ exclusiveMinimum: 0 }),
			lease: leaseSchema,
			result: summarySchema,
		},
		{ additionalProperties: false },
	),
]);
const documentSchema = Type.Refine(
	Type.Object(
		{
			format: Type.Literal(1),
			items: Type.Array(recordSchema, { maxItems: 12 }),
		},
		{ additionalProperties: false },
	),
	(document) =>
		new Set(document.items.map((item) => item.id)).size ===
		document.items.length,
	() => "Duplicate note IDs",
);
type QueueDocument = StaticDecode<typeof documentSchema>;
type ClaimedNote = Extract<
	QueueDocument["items"][number],
	{ status: "leased" }
>;
type ClaimReceipt = {
	readonly id: string;
	readonly owner: string;
	readonly token: string;
	readonly signal: AbortSignal | undefined;
};

type QueueOptions = {
	readonly leaseDurationMs: number;
	readonly now: () => number;
	readonly createToken: () => string;
};

export class WorkQueue {
	private isClosed = false;
	private constructor(
		private readonly input: QueueOptions & { readonly database: DatabaseSync },
	) {}

	static async open(
		input: QueueOptions & { readonly path: string; readonly create: boolean },
	): Promise<WorkQueue> {
		if (input.create) await mkdir(dirname(input.path), { recursive: true });
		else await access(input.path);
		const database = new DatabaseSync(input.path);
		try {
			database.exec(
				"PRAGMA busy_timeout = 30000; PRAGMA journal_mode = DELETE;",
			);
			if (input.create) {
				database.exec(
					"CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY CHECK (id = 1), document TEXT NOT NULL)",
				);
				database
					.prepare(
						"INSERT INTO queue (id, document) VALUES (1, ?) ON CONFLICT(id) DO NOTHING",
					)
					.run(JSON.stringify({ format: 1, items: [] }));
			}
			const queue = new WorkQueue({ ...input, database });
			queue.readDocument();
			return queue;
		} catch (error) {
			database.close();
			throw error;
		}
	}

	close(): void {
		if (this.isClosed) return;
		this.input.database.close();
		this.isClosed = true;
	}

	async enqueue(
		input: Note & { readonly signal: AbortSignal | undefined },
	): Promise<{ readonly isNew: boolean }> {
		const note = Value.Parse(noteSchema, { id: input.id, text: input.text });
		return this.mutate({
			signal: input.signal,
			apply: (document) => {
				const existing = document.items.find((item) => item.id === note.id);
				if (existing) {
					if (existing.text !== note.text)
						throw new Error(`Conflicting queue note: ${note.id}`);
					return { isNew: false };
				}
				if (document.items.length >= 12)
					throw new Error("The example queue retains at most 12 notes");
				document.items.push({ ...note, deliveries: 0, status: "available" });
				return { isNew: true };
			},
		});
	}

	async claim(input: {
		readonly owner: string;
		readonly signal: AbortSignal | undefined;
	}) {
		Value.Assert(leaseSchema.properties.owner, input.owner);
		return this.mutate({
			signal: input.signal,
			apply: (document, now) => {
				const held = document.items.find(
					(item) =>
						item.status === "leased" &&
						item.lease.owner === input.owner &&
						item.lease.expiresAt > now,
				);
				if (held?.status === "leased") return this.describeClaim(held);
				const index = document.items.findIndex(
					(item) =>
						item.status === "available" ||
						(item.status === "leased" && item.lease.expiresAt <= now),
				);
				if (index === -1) return null;
				const previous = document.items[index];
				const claimed: ClaimedNote = {
					id: previous.id,
					text: previous.text,
					deliveries: previous.deliveries + 1,
					status: "leased",
					lease: {
						owner: input.owner,
						token: this.input.createToken(),
						expiresAt: now + this.input.leaseDurationMs,
					},
				};
				document.items[index] = claimed;
				return this.describeClaim(claimed);
			},
		});
	}

	async acknowledge(
		input: ClaimReceipt & { readonly result: Summary },
	): Promise<void> {
		const result = Value.Parse(summarySchema, input.result);
		await this.mutate({
			signal: input.signal,
			apply: (document, now) => {
				const index = document.items.findIndex((item) => item.id === input.id);
				const item = document.items[index];
				if (
					item?.status === "acknowledged" &&
					item.lease.owner === input.owner &&
					item.lease.token === input.token
				) {
					if (!isDeepStrictEqual(item.result, result))
						throw new Error(`Conflicting queue result: ${input.id}`);
					return;
				}
				if (
					item?.status !== "leased" ||
					item.lease.owner !== input.owner ||
					item.lease.token !== input.token ||
					item.lease.expiresAt <= now
				) {
					throw new Error(`Stale or invalid queue lease: ${input.id}`);
				}
				document.items[index] = { ...item, status: "acknowledged", result };
			},
		});
	}

	async inspect() {
		const document = this.readDocument();
		const now = this.input.now();
		const items = document.items.map((item) => {
			const common = {
				id: item.id,
				text: item.text,
				deliveries: item.deliveries,
			};
			if (item.status === "acknowledged")
				return {
					...common,
					status: "acknowledged" as const,
					result: item.result,
				};
			if (item.status === "leased" && item.lease.expiresAt > now)
				return {
					...common,
					status: "leased" as const,
					expiresAt: item.lease.expiresAt,
				};
			return { ...common, status: "available" as const };
		});
		return {
			items,
			available: items.filter((item) => item.status === "available").length,
			leased: items.filter((item) => item.status === "leased").length,
			acknowledged: items.filter((item) => item.status === "acknowledged")
				.length,
		};
	}

	private describeClaim(item: ClaimedNote) {
		return {
			id: item.id,
			text: item.text,
			token: item.lease.token,
			expiresAt: item.lease.expiresAt,
			deliveries: item.deliveries,
		};
	}

	private readDocument(): QueueDocument {
		const row = this.input.database
			.prepare("SELECT document FROM queue WHERE id = 1")
			.get();
		if (!row) throw new Error("Missing queue document");
		return Value.Parse(documentSchema, JSON.parse(String(row.document)));
	}

	private async mutate<Value>(input: {
		readonly signal: AbortSignal | undefined;
		readonly apply: (document: QueueDocument, now: number) => Value;
	}): Promise<Value> {
		input.signal?.throwIfAborted();
		const database = this.input.database;
		database.exec("BEGIN IMMEDIATE");
		try {
			input.signal?.throwIfAborted();
			const document = this.readDocument();
			const value = input.apply(document, this.input.now());
			Value.Assert(documentSchema, document);
			database
				.prepare("UPDATE queue SET document = ? WHERE id = 1")
				.run(JSON.stringify(document));
			database.exec("COMMIT");
			return value;
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
	}
}

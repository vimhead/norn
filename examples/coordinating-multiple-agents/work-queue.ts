import type { NornFileCoordinator, NornResourceDefinition } from "@vimhead.dev/norn";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Type, type StaticDecode } from "typebox";
import { Value } from "typebox/value";

export const noteSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }), text: Type.String({ minLength: 5, maxLength: 1000 }) }, { additionalProperties: false });
export const summarySchema = Type.Object({ summary: Type.String({ minLength: 1, maxLength: 240 }), quote: Type.String({ minLength: 5, maxLength: 240 }) }, { additionalProperties: false });
type Note = StaticDecode<typeof noteSchema>;
export type Summary = StaticDecode<typeof summarySchema>;
const leaseSchema = Type.Object({ owner: Type.String({ minLength: 1, maxLength: 128 }), token: Type.String({ format: "uuid" }), expiresAt: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
const recordSchema = Type.Union([
	Type.Object({ ...noteSchema.properties, status: Type.Literal("available"), deliveries: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
	Type.Object({ ...noteSchema.properties, status: Type.Literal("leased"), deliveries: Type.Integer({ exclusiveMinimum: 0 }), lease: leaseSchema }, { additionalProperties: false }),
	Type.Object({ ...noteSchema.properties, status: Type.Literal("acknowledged"), deliveries: Type.Integer({ exclusiveMinimum: 0 }), lease: leaseSchema, result: summarySchema }, { additionalProperties: false }),
]);
const documentSchema = Type.Refine(Type.Object({ format: Type.Literal(1), items: Type.Array(recordSchema, { maxItems: 12 }) }, { additionalProperties: false }), document => new Set(document.items.map(item => item.id)).size === document.items.length, () => "Duplicate note IDs");
type QueueDocument = StaticDecode<typeof documentSchema>;
type ClaimedNote = Extract<QueueDocument["items"][number], { status: "leased" }>;
type ClaimReceipt = { readonly id: string; readonly owner: string; readonly token: string; readonly signal: AbortSignal | undefined };

export class WorkQueue {
	constructor(private readonly input: {
		readonly path: string;
		readonly files: NornFileCoordinator;
		readonly leaseDurationMs: number;
		readonly now: () => number;
		readonly createToken: () => string;
	}) {}

	async initialize(mode: "create" | "open"): Promise<void> {
		await this.input.files.withExclusiveLock(this.input.path, async path => {
			try {
				await this.readDocument(path);
			} catch (error) {
				if (mode !== "create" || !(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
				await this.writeDocument(path, { format: 1, items: [] });
			}
		});
	}

	async enqueue(input: Note & { readonly signal: AbortSignal | undefined }): Promise<{ readonly isNew: boolean }> {
		const note = Value.Parse(noteSchema, { id: input.id, text: input.text });
		return this.mutate({ signal: input.signal, apply: document => {
			const existing = document.items.find(item => item.id === note.id);
			if (existing) {
				if (existing.text !== note.text) throw new Error(`Conflicting queue note: ${note.id}`);
				return { isNew: false };
			}
			if (document.items.length >= 12) throw new Error("The example queue retains at most 12 notes");
			document.items.push({ ...note, deliveries: 0, status: "available" });
			return { isNew: true };
		} });
	}

	async claim(input: { readonly owner: string; readonly signal: AbortSignal | undefined }) {
		Value.Assert(leaseSchema.properties.owner, input.owner);
		return this.mutate({ signal: input.signal, apply: (document, now) => {
			const held = document.items.find(item => item.status === "leased" && item.lease.owner === input.owner && item.lease.expiresAt > now);
			if (held?.status === "leased") return this.describeClaim(held);
			const index = document.items.findIndex(item => item.status === "available" || (item.status === "leased" && item.lease.expiresAt <= now));
			if (index === -1) return null;
			const previous = document.items[index];
			const claimed: ClaimedNote = {
				id: previous.id, text: previous.text, deliveries: previous.deliveries + 1, status: "leased",
				lease: { owner: input.owner, token: this.input.createToken(), expiresAt: now + this.input.leaseDurationMs },
			};
			document.items[index] = claimed;
			return this.describeClaim(claimed);
		} });
	}

	async acknowledge(input: ClaimReceipt & { readonly result: Summary }): Promise<void> {
		const result = Value.Parse(summarySchema, input.result);
		await this.mutate({ signal: input.signal, apply: (document, now) => {
			const index = document.items.findIndex(item => item.id === input.id);
			const item = document.items[index];
			if (item?.status === "acknowledged" && item.lease.owner === input.owner && item.lease.token === input.token) {
				if (!isDeepStrictEqual(item.result, result)) throw new Error(`Conflicting queue result: ${input.id}`);
				return;
			}
			if (item?.status !== "leased" || item.lease.owner !== input.owner || item.lease.token !== input.token || item.lease.expiresAt <= now) {
				throw new Error(`Stale or invalid queue lease: ${input.id}`);
			}
			document.items[index] = { ...item, status: "acknowledged", result };
		} });
	}

	async inspect() {
		return this.input.files.withExclusiveLock(this.input.path, async path => {
			const document = await this.readDocument(path);
			const now = this.input.now();
			const items = document.items.map(item => {
				const common = { id: item.id, text: item.text, deliveries: item.deliveries };
				if (item.status === "acknowledged") return { ...common, status: "acknowledged" as const, result: item.result };
				if (item.status === "leased" && item.lease.expiresAt > now) return { ...common, status: "leased" as const, expiresAt: item.lease.expiresAt };
				return { ...common, status: "available" as const };
			});
			return {
				items, available: items.filter(item => item.status === "available").length,
				leased: items.filter(item => item.status === "leased").length,
				acknowledged: items.filter(item => item.status === "acknowledged").length,
			};
		});
	}

	private describeClaim(item: ClaimedNote) {
		return { id: item.id, text: item.text, token: item.lease.token, expiresAt: item.lease.expiresAt, deliveries: item.deliveries };
	}

	private async readDocument(path: string): Promise<QueueDocument> {
		return Value.Parse(documentSchema, JSON.parse(await readFile(path, "utf8")));
	}

	private async writeDocument(path: string, document: QueueDocument): Promise<void> {
		const temporary = `${path}.${this.input.createToken()}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify(document), { flag: "wx", mode: 0o600 });
			await rename(temporary, path);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EEXIST") throw error;
			try { await rm(temporary, { force: true }); }
			catch (cleanupError) { throw new AggregateError([error, cleanupError], "Queue write and cleanup failed"); }
			throw error;
		}
	}

	private async mutate<Value>(input: { readonly signal: AbortSignal | undefined; readonly apply: (document: QueueDocument, now: number) => Value }): Promise<Value> {
		input.signal?.throwIfAborted();
		return this.input.files.withExclusiveLock(this.input.path, async path => {
			input.signal?.throwIfAborted();
			const document = await this.readDocument(path);
			input.signal?.throwIfAborted();
			const value = input.apply(document, this.input.now());
			await this.writeDocument(path, document);
			return value;
		});
	}
}

const configuration = { format: 1, leaseDurationMs: 300_000 };
export const workQueueDefinition: NornResourceDefinition<WorkQueue> = {
	name: "summaries",
	kind: "example.note-summaries",
	configuration,
	async initialize({ directory, files, mode }) {
		const queue = new WorkQueue({ path: join(directory, "queue.json"), files, leaseDurationMs: configuration.leaseDurationMs, now: Date.now, createToken: randomUUID });
		await queue.initialize(mode);
		return queue;
	},
};

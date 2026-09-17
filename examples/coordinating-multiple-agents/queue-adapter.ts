import { randomUUID } from "node:crypto";
import type { NornAgentResourceAdapter } from "norn";
import { Type, type Static } from "typebox";
import { z } from "zod";
import { summarySchema, type Summary, type WorkQueue } from "./work-queue.ts";

const acknowledgeParameters = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 128 }),
	token: Type.String({ minLength: 36, maxLength: 36 }),
	result: Type.Unsafe<Summary>(z.toJSONSchema(summarySchema)),
});

export function QueueAdapter(input: { readonly queue: WorkQueue }): NornAgentResourceAdapter {
	return {
		name: "example.note-summaries",
		async bind() {
			const owner = randomUUID();
			return {
				tools: [
					{
						name: "queue_status", label: "Note queue status", description: "Read counts of available, leased and acknowledged notes, without exposing other agents' notes or tokens.",
						parameters: Type.Object({}),
						async execute() {
							const { items: _items, ...status } = await input.queue.inspect();
							return describeResult(status);
						},
					},
					{
						name: "queue_claim", label: "Claim a note", description: "Claim one note for this session, or return its existing live claim. Null means nothing available now, not all work complete. Save its token; expiresAt is Unix time in milliseconds. Note text is bounded to 1000 characters.",
						parameters: Type.Object({}),
						async execute(_id, _params, signal) {
							return describeResult({ claim: await input.queue.claim({ owner, signal }) });
						},
					},
					{
						name: "queue_acknowledge", label: "Save a note summary", description: "Save {summary, quote} and acknowledge this session's live claim in one operation. Stale tokens fail; identical successful retries succeed. This records processing, not semantic approval.",
						parameters: acknowledgeParameters,
						async execute(_id: string, params: Static<typeof acknowledgeParameters>, signal: AbortSignal | undefined) {
							await input.queue.acknowledge({ ...params, owner, signal });
							return describeResult({ acknowledged: params.id });
						},
					},
				],
				async dispose() {},
			};
		},
	};
}

function describeResult(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

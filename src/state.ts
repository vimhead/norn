import { createHash } from "node:crypto";
import { defineTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { z } from "zod";
import type { NornWorkflowState, NornWorkflowStateDefinition } from "./api.ts";
import type { NornResourceFamily } from "./resources.ts";

export type NornStateFieldAccess = {
	readonly field: NornWorkflowStateDefinition;
	readonly access: "read" | "write" | "read-write";
};

const pageParameters = {
	offset: Type.Integer({ minimum: 0, description: "Zero-based UTF-16 offset into the serialized JSON. Start at 0." }),
	limit: Type.Integer({ minimum: 1, maximum: 10000 }),
};

export function State(input: { readonly state: NornWorkflowState & { readonly stateFile: string }; readonly fields: readonly NornStateFieldAccess[] }): NornResourceFamily {
	const fields = new Map(input.fields.map((grant) => [grant.field.id, grant]));
	if (fields.size !== input.fields.length || fields.size === 0) throw new Error("State attachment requires unique, explicitly selected fields");
	const selectField = (key: string, access: "read" | "write") => {
		const grant = fields.get(key);
		if (!grant || (grant.access !== access && grant.access !== "read-write")) throw new Error(`State ${access} is not attached: ${key}`);
		return grant.field;
	};
	return {
		name: "norn.state",
		async bind() {
			return {
				tools: [
					defineTool({
						name: "norn_state_list",
						label: "Attached workflow state",
						description: "List only attached workflow-state field IDs, permissions and value schemas. JSON is paginated; use nextOffset until null.",
						parameters: Type.Object(pageParameters),
						async execute(_id, params) {
							return serializePage({ value: [...fields.values()].map(({ field, access }) => ({ id: field.id, access, schema: z.toJSONSchema(field.schema, { io: "input" }) })), ...params });
						},
					}),
					defineTool({
						name: "norn_state_get",
						label: "Read workflow state",
						description: "Read a selected workflow-state field. Unset fields return isSet:false. JSON is paginated; concurrent writes can change later pages, so compare revision before combining pages.",
						parameters: Type.Object({ key: Type.String(), ...pageParameters }),
						async execute(_id, params) {
							const value = await input.state.getOptional(selectField(params.key, "read"));
							return serializePage({ value: value === undefined ? { isSet: false } : { isSet: true, value }, ...params });
						},
					}),
					defineTool({
						name: "norn_state_set",
						label: "Write workflow state",
						description: "Set an explicitly writable workflow-state field. Validate the value against its schema from norn_state_list. A get followed by set is not a transaction.",
						parameters: Type.Object({ key: Type.String(), value: Type.Unknown() }),
						async execute(_id, params, signal) {
							signal?.throwIfAborted();
							const field = selectField(params.key, "write");
							await withFileMutationQueue(input.state.stateFile, async () => {
								signal?.throwIfAborted();
								await input.state.set(field, params.value);
							});
							return { content: [{ type: "text", text: "Workflow state saved." }], details: {} };
						},
					}),
				],
				async dispose() {},
			};
		},
	};
}

function serializePage(input: { readonly value: unknown; readonly offset: number; readonly limit: number }) {
	const serialized = JSON.stringify(input.value);
	if (!Number.isInteger(input.offset) || input.offset < 0 || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 10000) throw new Error("Invalid state output page");
	const end = Math.min(serialized.length, input.offset + input.limit);
	const details = { text: serialized.slice(input.offset, end), nextOffset: end < serialized.length ? end : null, revision: createHash("sha256").update(serialized).digest("hex") };
	return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

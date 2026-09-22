import { createHash } from "node:crypto";
import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@vimhead.dev/norn";
import type { SharedStateAccess, SharedStateField } from "./shared-state.ts";
import { inspectSchema } from "@vimhead.dev/norn/schema";

function defineTool<Schema extends TSchema>(
	tool: ToolDefinition<Schema>,
): ToolDefinition<Schema> {
	return tool;
}

export type StateFieldAccess = {
	readonly field: SharedStateField;
	readonly access: "read" | "write" | "read-write";
};

const pageParameters = {
	offset: Type.Integer({
		minimum: 0,
		description:
			"Zero-based UTF-16 offset into the serialized JSON. Start at 0.",
	}),
	limit: Type.Integer({ minimum: 1, maximum: 10000 }),
};

export function createStateTools(input: {
	readonly state: SharedStateAccess;
	readonly fields: readonly StateFieldAccess[];
}): ToolDefinition[] {
	const fields = new Map(input.fields.map((grant) => [grant.field.id, grant]));
	if (fields.size !== input.fields.length || fields.size === 0)
		throw new Error("State tools require unique, explicitly selected fields");
	const selectField = (key: string, access: "read" | "write") => {
		const grant = fields.get(key);
		if (!grant || (grant.access !== access && grant.access !== "read-write"))
			throw new Error(`State ${access} is not attached: ${key}`);
		return grant.field;
	};
	return [
		defineTool({
			name: "norn_state_list",
			label: "Attached workflow state",
			description:
				"List only attached workflow-state field IDs, permissions and value schemas. JSON is paginated; use nextOffset until null.",
			parameters: Type.Object(pageParameters),
			async execute(_id, args) {
				return serializePage({
					value: [...fields.values()].map(({ field, access }) => ({
						id: field.id,
						access,
						schema: inspectSchema(field.schema),
					})),
					...args,
				});
			},
		}),
		defineTool({
			name: "norn_state_get",
			label: "Read workflow state",
			description:
				"Read a selected workflow-state field. Unset fields return isSet:false. JSON is paginated; concurrent writes can change later pages, so compare revision before combining pages.",
			parameters: Type.Object({ key: Type.String(), ...pageParameters }),
			async execute(_id, args) {
				const value = await input.state.getOptional(
					selectField(args.key, "read"),
				);
				return serializePage({
					value:
						value === undefined ? { isSet: false } : { isSet: true, value },
					...args,
				});
			},
		}),
		defineTool({
			name: "norn_state_set",
			label: "Write workflow state",
			description:
				"Set an explicitly writable workflow-state field. Validate the value against its schema from norn_state_list. A get followed by set is not a transaction.",
			parameters: Type.Object({ key: Type.String(), value: Type.Unknown() }),
			async execute(_id, args, signal) {
				signal?.throwIfAborted();
				const field = selectField(args.key, "write");
				await input.state.set(field, args.value);
				return {
					content: [{ type: "text", text: "Workflow state saved." }],
					details: {},
				};
			},
		}),
	];
}

function serializePage(input: {
	readonly value: unknown;
	readonly offset: number;
	readonly limit: number;
}) {
	const serialized = JSON.stringify(input.value);
	if (
		!Number.isInteger(input.offset) ||
		input.offset < 0 ||
		!Number.isInteger(input.limit) ||
		input.limit < 1 ||
		input.limit > 10000
	)
		throw new Error("Invalid state output page");
	const end = Math.min(serialized.length, input.offset + input.limit);
	const details = {
		text: serialized.slice(input.offset, end),
		nextOffset: end < serialized.length ? end : null,
		revision: createHash("sha256").update(serialized).digest("hex"),
	};
	return {
		content: [{ type: "text" as const, text: JSON.stringify(details) }],
		details,
	};
}

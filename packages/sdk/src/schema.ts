import { Type, type Static, type TSchema } from "typebox";
import { Meta } from "typebox/schema";
import { Value } from "typebox/value";
import type { NornAnyWorkflowDeclaration, NornJsonSchema } from "./api.ts";

export const jsonValueSchema = Type.Cyclic({
	Json: Type.Union([
		Type.Null(), Type.Boolean(), Type.Number(), Type.String(),
		Type.Array(Type.Ref("Json")),
		Type.Refine(Type.Record(Type.String(), Type.Ref("Json")), value => Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
	]),
}, "Json");

export type NornJsonValue = Static<typeof jsonValueSchema>;

export function inspectSchema(schema: TSchema): NornJsonSchema {
	const inspected: unknown = JSON.parse(JSON.stringify(schema));
	Value.Assert(Meta["https://json-schema.org/draft/2020-12/schema"], inspected);
	if (!isPlainObject(inspected)) throw new Error("Norn inspection requires an object schema");
	assertWorkflowReferenceAnnotations(inspected);
	return inspected;
}

function assertWorkflowReferenceAnnotations(schema: unknown): void {
	if (!isPlainObject(schema)) return;
	if (Object.hasOwn(schema, "x-norn-workflow-ref")) {
		const annotation = schema["x-norn-workflow-ref"];
		if (!isPlainObject(annotation) || !Object.hasOwn(annotation, "contributedParamsSchema")) throw new Error("Invalid workflow reference annotation");
		Value.Assert(Meta["https://json-schema.org/draft/2020-12/schema"], annotation.contributedParamsSchema);
		assertWorkflowReferenceAnnotations(annotation.contributedParamsSchema);
	}
	for (const keyword of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
		const schemas = schema[keyword];
		if (isPlainObject(schemas)) for (const child of Object.values(schemas)) assertWorkflowReferenceAnnotations(child);
	}
	for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
		const schemas = schema[keyword];
		if (Array.isArray(schemas)) for (const child of schemas) assertWorkflowReferenceAnnotations(child);
	}
	for (const keyword of ["additionalProperties", "unevaluatedProperties", "propertyNames", "items", "contains", "not", "if", "then", "else", "unevaluatedItems", "contentSchema"]) {
		assertWorkflowReferenceAnnotations(schema[keyword]);
	}
}

export function assertWorkflowMetadata(workflow: NornAnyWorkflowDeclaration): void {
	if (workflow.instructions !== undefined && (typeof workflow.instructions !== "string" || workflow.instructions.trim().length === 0)) {
		throw new Error(`Workflow instructions must be a nonempty string: ${workflow.id}`);
	}
	if (workflow.isEntrypoint && workflow.instructions === undefined) {
		throw new Error(`Entrypoint workflow requires instructions: ${workflow.id}`);
	}
}

export function unwrapSchema(schema: TSchema): TSchema {
	if (!Type.IsUnion(schema)) return schema;
	const members = schema.anyOf.filter(member => !Type.IsNull(member));
	return members.length === 1 ? unwrapSchema(members[0]) : schema;
}

export function schemaShape(schema: TSchema): Record<string, TSchema> {
	const unwrapped = unwrapSchema(schema);
	return Type.IsObject(unwrapped) ? unwrapped.properties : {};
}

export function schemaType(schema: TSchema): string | undefined {
	const unwrapped = unwrapSchema(schema);
	return "type" in unwrapped && typeof unwrapped.type === "string" ? unwrapped.type : undefined;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

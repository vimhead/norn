import { artifactRefSchema, definePluginManifest, workflowRefSchema, type NornWorkflowRefSchemaOptions } from "@vimhead.dev/norn";
import { inspectSchema } from "@vimhead.dev/norn/schema";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { expect, test } from "vitest";

const target = definePluginManifest({
	id: "refs", workflows: { finish: { isEntrypoint: false, params: Type.Object({ report: Type.String() }) } },
}).workflows.finish;

for (const reference of ["refs.finish", target.id]) {
	test("workflow references decode IDs and explicit forwarding objects", () => {
		const contributions = Type.Object({ report: Type.String() });
		const options: NornWorkflowRefSchemaOptions<typeof contributions> = { params: contributions };
		const schema = workflowRefSchema(options);
		assert.deepEqual(Value.Decode(workflowRefSchema({}), reference), { workflow: "refs.finish", forwardParams: {} });
		assert.deepEqual(Value.Decode(schema, reference), { workflow: "refs.finish", forwardParams: {} });
		assert.deepEqual(Value.Decode(schema, { workflow: reference, forwardParams: { task: "retain" } }), {
			workflow: "refs.finish", forwardParams: { task: "retain" },
		});
	});
}

test("nullable reference inputs retain their required property and input union", () => {
	const schema = Type.Object({ next: Type.Union([workflowRefSchema(), Type.Null()]) });
	const inspected = inspectSchema(schema);
	assert.deepEqual(inspected.required, ["next"]);
	assert.equal(Value.Check(schema, {}), false);
	assert.equal(Value.Check(schema, { next: null }), true);
	assert.equal(Value.Check(schema, { next: "refs.finish" }), true);
	expect(inspected).toHaveProperty("properties.next.anyOf.0.anyOf.0.type", "string");
	expect(inspected).toHaveProperty("properties.next.anyOf.0.anyOf.1.required", ["workflow", "forwardParams"]);
});

test("optional reference properties remain optional in validation and inspection", () => {
	const schema = Type.Object({ next: Type.Optional(workflowRefSchema()) });
	assert.deepEqual(Value.Decode(schema, {}), {});
	assert.equal(inspectSchema(schema).required, undefined);
});

test("inspection advertises input contributions alongside the reference and forwarding schemas", () => {
	const contributions = Type.Object({
		records: artifactRefSchema,
		count: Type.Decode(Type.String(), Number),
		label: Type.Optional(Type.String({ default: "collected" })),
	});
	const reference = Type.With(workflowRefSchema({ params: contributions }), { description: "Continue with the collected records" });
	const schema = Type.Object({ next: reference });
	const inspected = inspectSchema(schema);
	expect(inspected).toHaveProperty("properties.next.x-norn-workflow-ref.contributedParamsSchema", inspectSchema(contributions));
	expect(inspected).toHaveProperty("properties.next.description", "Continue with the collected records");
	expect(inspected).toHaveProperty("properties.next.anyOf", inspectSchema(workflowRefSchema()).anyOf);
	expect(inspected).toHaveProperty("properties.next.anyOf.1.properties.forwardParams.patternProperties", { "^.*$": {} });
	expect(inspected).toHaveProperty("properties.next.x-norn-workflow-ref.contributedParamsSchema.required", ["records", "count"]);
	expect(inspected).toHaveProperty("properties.next.x-norn-workflow-ref.contributedParamsSchema.properties.count.type", "string");
	const forwardParams = { taskId: "task-42", nested: { labels: ["one", "two"], enabled: false, absent: null } };
	const input = { next: { workflow: "refs.finish", forwardParams } };
	assert.deepEqual(Value.Decode(schema, input), input);
});

test("references without contributions advertise an empty object schema", () => {
	const reference = workflowRefSchema();
	expect(inspectSchema(reference)).toHaveProperty("x-norn-workflow-ref.contributedParamsSchema", inspectSchema(Type.Object({})));
	assert.deepEqual(Value.Decode(reference, "refs.finish"), { workflow: "refs.finish", forwardParams: {} });
});

test("optional, nullable and array references retain contribution annotations and codecs", () => {
	const contributions = Type.Object({ report: Type.String() });
	const reference = workflowRefSchema({ params: contributions });
	const schema = Type.Object({ optional: Type.Optional(reference), nullable: Type.Union([reference, Type.Null()]), many: Type.Array(reference) });
	const inspected = inspectSchema(schema);
	for (const path of ["properties.optional", "properties.nullable.anyOf.0", "properties.many.items"]) {
		expect(inspected).toHaveProperty(`${path}.x-norn-workflow-ref.contributedParamsSchema`, inspectSchema(contributions));
	}
	assert.deepEqual(inspected.required, ["nullable", "many"]);
	assert.deepEqual(Value.Decode(schema, { nullable: null, many: ["refs.finish"] }), { nullable: null, many: [{ workflow: "refs.finish", forwardParams: {} }] });
});

test("nested continuations retain their own contribution contracts", () => {
	const finalContributions = Type.Object({ summary: Type.String() });
	const contributions = Type.Object({ records: artifactRefSchema, next: workflowRefSchema({ params: finalContributions }) });
	const inspected = inspectSchema(workflowRefSchema({ params: contributions }));
	expect(inspected).toHaveProperty("x-norn-workflow-ref.contributedParamsSchema.properties.next.x-norn-workflow-ref.contributedParamsSchema", inspectSchema(finalContributions));
});

test("recursive contributions use native TypeBox definitions", () => {
	const contributions = Type.Cyclic({ Contribution: Type.Object({ label: Type.String(), children: Type.Array(Type.Ref("Contribution")) }) }, "Contribution");
	const reference = workflowRefSchema({ params: contributions });
	expect(inspectSchema(reference)).toHaveProperty("x-norn-workflow-ref.contributedParamsSchema", inspectSchema(contributions));
	assert.deepEqual(Value.Decode(reference, "refs.finish"), { workflow: "refs.finish", forwardParams: {} });
});

test("non-JSON contributions fail inspection without preventing reference construction", () => {
	const reference = workflowRefSchema({ params: Type.BigInt() });
	assert.deepEqual(Value.Decode(reference, "refs.finish"), { workflow: "refs.finish", forwardParams: {} });
	assert.throws(() => inspectSchema(reference));
});

for (const input of [undefined, null, "", 3, {}, { workflow: "refs.finish" }, { workflow: "", forwardParams: {} }, { workflow: "refs.finish", forwardParams: null }]) {
	test(`reference input schema rejects invalid shape without coercion: ${JSON.stringify(input)}`, () => {
		assert.equal(Value.Check(workflowRefSchema(), input), false);
	});
}

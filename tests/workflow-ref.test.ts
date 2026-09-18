import { artifactRefSchema, definePluginManifest, isWorkflowDeclaration, isWorkflowPluginManifest, workflowRefSchema, type NornWorkflowRefSchemaOptions } from "@vimhead.dev/norn";
import { inspectSchema } from "@vimhead.dev/norn/schema";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { expect, expectTypeOf, test } from "vitest";

const manifest = definePluginManifest({
	id: "refs", workflows: { finish: { isEntrypoint: false, params: Type.Object({ report: Type.String() }) } },
});
const target = manifest.workflows.finish;

test("callable declarations retain metadata and construct transitions without execution", () => {
	expectTypeOf(target.id).toEqualTypeOf<"refs.finish">();
	assert.equal(isWorkflowDeclaration(target), true);
	assert.equal(isWorkflowPluginManifest(manifest), true);
	assert.equal(isWorkflowDeclaration(() => undefined), false);
	assert.equal(Value.Check(target.params, { report: "done" }), true);
	assert.deepEqual(target.isolation, { mode: "runWorkspace" });
	assert.deepEqual(target({ report: "done" }), { type: "next", workflowId: target.id, params: { report: "done" } });
});

for (const reference of ["refs.finish", target.id]) {
	test("workflow references decode into contribution-taking transition builders", () => {
		const contributions = Type.Object({ report: Type.String() });
		const options: NornWorkflowRefSchemaOptions<typeof contributions> = { params: contributions };
		const schema = workflowRefSchema(options);
		assert.deepEqual(Value.Decode(workflowRefSchema({}), reference)({}), { type: "next", workflowId: "refs.finish", params: {} });
		interface Report { report: string }
		const report: Report = { report: "done" };
		assert.deepEqual(Value.Decode(schema, reference)(report), target(report));
		const input = { workflow: reference, forwardParams: { task: "retain", report: "stale" } };
		const next = Value.Decode(schema, input);
		assert.deepEqual(next({ report: "done" }), { type: "next", workflowId: reference, params: { task: "retain", report: "done" } });
		assert.deepEqual(next({ report: "again" }).params, { task: "retain", report: "again" });
		assert.deepEqual(input.forwardParams, { task: "retain", report: "stale" });
		assert.throws(() => Reflect.apply(next, undefined, [{}]));
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

test("inspection advertises encoded contributions and invocation does not decode them", () => {
	let decodes = 0;
	const contributions = Type.Object({
		records: artifactRefSchema,
		count: Type.Decode(Type.String(), value => { decodes++; return Number(value); }),
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
	const next = Value.Decode(schema, { next: { workflow: "refs.finish", forwardParams } }).next;
	const contribution = { records: { path: "records.json" }, count: "2" };
	assert.deepEqual(next(contribution).params, { ...forwardParams, ...contribution });
	assert.equal(decodes, 0);
	assert.throws(() => Reflect.apply(next, undefined, [{ records: { path: "records.json" }, count: 2 }]));
});

test("references without contributions advertise an empty object schema", () => {
	const reference = workflowRefSchema();
	expect(inspectSchema(reference)).toHaveProperty("x-norn-workflow-ref.contributedParamsSchema", inspectSchema(Type.Object({})));
	assert.deepEqual(Value.Decode(reference, "refs.finish")({}), { type: "next", workflowId: "refs.finish", params: {} });
});

test("optional, nullable and array references retain annotations and callable codecs", () => {
	const reference = workflowRefSchema({ params: Type.Object({ report: Type.String() }) });
	const schema = Type.Object({ optional: Type.Optional(reference), nullable: Type.Union([reference, Type.Null()]), many: Type.Array(reference) });
	const inspected = inspectSchema(schema);
	for (const path of ["properties.optional", "properties.nullable.anyOf.0", "properties.many.items"]) {
		expect(inspected).toHaveProperty(`${path}.x-norn-workflow-ref.contributedParamsSchema`, inspectSchema(Type.Object({ report: Type.String() })));
	}
	assert.deepEqual(inspected.required, ["nullable", "many"]);
	const decoded = Value.Decode(schema, { nullable: null, many: ["refs.finish"], optional: "refs.finish" });
	assert.equal(decoded.nullable, null);
	assert.deepEqual(decoded.many[0]({ report: "array" }), target({ report: "array" }));
	assert.deepEqual(decoded.optional!({ report: "optional" }), target({ report: "optional" }));
});

test("nested references retain encoded payloads in contributed parameters", () => {
	const finalContributions = Type.Object({ summary: Type.String() });
	const contributions = Type.Object({ records: artifactRefSchema, next: workflowRefSchema({ params: finalContributions }) });
	const reference = workflowRefSchema({ params: contributions });
	expect(inspectSchema(reference)).toHaveProperty("x-norn-workflow-ref.contributedParamsSchema.properties.next.x-norn-workflow-ref.contributedParamsSchema", inspectSchema(finalContributions));
	const params = { records: { path: "records.json" }, next: { workflow: "refs.finish", forwardParams: { batch: 1 } } };
	const transition = Value.Decode(reference, "intermediate")(params);
	assert.deepEqual(transition.params, params);
	assert.deepEqual(Value.Decode(contributions, transition.params).next({ summary: "done" }).params, { batch: 1, summary: "done" });
});

test("recursive contributions use native TypeBox definitions", () => {
	const contributions = Type.Cyclic({ Contribution: Type.Object({ label: Type.String(), children: Type.Array(Type.Ref("Contribution")) }) }, "Contribution");
	const reference = workflowRefSchema({ params: contributions });
	expect(inspectSchema(reference)).toHaveProperty("x-norn-workflow-ref.contributedParamsSchema", inspectSchema(contributions));
	const params = { label: "root", children: [{ label: "leaf", children: [] }] };
	assert.deepEqual(Value.Decode(reference, "refs.finish")(params).params, params);
});

test("object-valued unions, records, intersections and root codecs can contribute", () => {
	const union = workflowRefSchema({ params: Type.Union([Type.Object({ kind: Type.Literal("ok"), report: Type.String() }), Type.Object({ kind: Type.Literal("error"), reason: Type.String() })]) });
	assert.deepEqual(Value.Decode(union, "target")({ kind: "error", reason: "failed" }).params, { kind: "error", reason: "failed" });
	const record = workflowRefSchema({ params: Type.Record(Type.String(), Type.Integer()) });
	assert.deepEqual(Value.Decode(record, "target")({ first: 1 }).params, { first: 1 });
	const intersection = workflowRefSchema({ params: Type.Intersect([Type.Object({ left: Type.String() }), Type.Object({ right: Type.Integer() })]) });
	assert.deepEqual(Value.Decode(intersection, "target")({ left: "x", right: 2 }).params, { left: "x", right: 2 });
	const codec = workflowRefSchema({ params: Type.Decode(Type.Object({ text: Type.String() }), value => value.text) });
	assert.deepEqual(Value.Decode(codec, "target")({ text: "encoded" }).params, { text: "encoded" });
	const unknown = Value.Decode(workflowRefSchema({ params: Type.Unknown() }), "target");
	for (const value of [null, [], "text", 1]) assert.throws(() => Reflect.apply(unknown, undefined, [value]), /contributions must be objects/);
	for (const value of [new Date(), { callback: () => undefined }]) assert.throws(() => Reflect.apply(unknown, undefined, [value]));
});

test("non-JSON contributions fail explicit inspection without preventing construction", () => {
	const reference = workflowRefSchema({ params: Type.BigInt() });
	assert.equal(typeof Value.Decode(reference, "refs.finish"), "function");
	assert.throws(() => inspectSchema(reference));
	const nested = workflowRefSchema({ params: Type.Object({ next: reference }) });
	assert.throws(() => inspectSchema(Type.Object({ next: Type.Optional(Type.Array(nested)) })));
});

test("inspection traverses schema positions, not defaults, examples or property-name maps", () => {
	const payload = { "x-norn-workflow-ref": { contributedParamsSchema: { type: "bigint" } } };
	const schema = Type.Object({ "x-norn-workflow-ref": Type.String() }, { default: payload, examples: [payload] });
	assert.doesNotThrow(() => inspectSchema(schema));
	const invalid = workflowRefSchema({ params: Type.BigInt() });
	for (const wrapper of [Type.Record(Type.String(), invalid), Type.Tuple([invalid]), Type.Object({}, { additionalProperties: invalid }), Type.Cyclic({ Root: Type.Object({ child: invalid }) }, "Root")]) {
		assert.throws(() => inspectSchema(wrapper));
	}
});

for (const input of [undefined, null, "", 3, {}, { workflow: "refs.finish" }, { workflow: "", forwardParams: {} }, { workflow: "refs.finish", forwardParams: null }, { workflow: target, forwardParams: {} }]) {
	test(`reference input schema rejects invalid shape without coercion: ${JSON.stringify(input)}`, () => {
		assert.equal(Value.Check(workflowRefSchema(), input), false);
	});
}

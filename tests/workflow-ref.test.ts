import {
	workflowScope,
	isWorkflowDeclaration,
	workflowRefSchema,
	type NornWorkflowRefSchemaOptions,
} from "@vimhead.dev/norn";
import { inspectSchema } from "@vimhead.dev/norn/schema";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { expect, expectTypeOf, test } from "vitest";

const refs = workflowScope({ name: "refs" });
const target = refs.workflow({
	name: "finish",
	entrypoint: false,
	args: Type.Object({ report: Type.String() }),
	execute() {
		throw new Error("A callable must select a transition, not execute it");
	},
});

test("callable declarations retain metadata and construct transitions without execution", () => {
	expectTypeOf(target.id).toEqualTypeOf<"refs.finish">();
	assert.equal(isWorkflowDeclaration(target), true);
	assert.equal(
		isWorkflowDeclaration(() => undefined),
		false,
	);
	assert.equal(Value.Check(target.args, { report: "done" }), true);
	assert.deepEqual(target({ report: "done" }), {
		type: "next",
		workflowId: target.id,
		args: { report: "done" },
	});
});

for (const reference of ["refs.finish", target.id]) {
	test("workflow references decode into contribution-taking transition builders", () => {
		const contributions = Type.Object({ report: Type.String() });
		const options: NornWorkflowRefSchemaOptions<typeof contributions> = {
			args: contributions,
		};
		const schema = workflowRefSchema(options);
		assert.deepEqual(Value.Decode(workflowRefSchema({}), reference)({}), {
			type: "next",
			workflowId: "refs.finish",
			args: {},
		});
		interface Report {
			report: string;
		}
		const report: Report = { report: "done" };
		assert.deepEqual(Value.Decode(schema, reference)(report), target(report));
		const input = {
			workflow: reference,
			forwardArgs: { task: "retain", report: "stale" },
		};
		const next = Value.Decode(schema, input);
		assert.deepEqual(next({ report: "done" }), {
			type: "next",
			workflowId: reference,
			args: { task: "retain", report: "done" },
		});
		assert.deepEqual(next({ report: "again" }).args, {
			task: "retain",
			report: "again",
		});
		assert.deepEqual(input.forwardArgs, { task: "retain", report: "stale" });
		assert.throws(() => Reflect.apply(next, undefined, [{}]));
	});
}

test("nullable reference inputs retain their required property and input union", () => {
	const schema = Type.Object({
		next: Type.Union([workflowRefSchema(), Type.Null()]),
	});
	const inspected = inspectSchema(schema);
	assert.deepEqual(inspected.required, ["next"]);
	assert.equal(Value.Check(schema, {}), false);
	assert.equal(Value.Check(schema, { next: null }), true);
	assert.equal(Value.Check(schema, { next: "refs.finish" }), true);
	expect(inspected).toHaveProperty(
		"properties.next.anyOf.0.anyOf.0.type",
		"string",
	);
	expect(inspected).toHaveProperty("properties.next.anyOf.0.anyOf.1.required", [
		"workflow",
		"forwardArgs",
	]);
});

test("optional reference properties remain optional in validation and inspection", () => {
	const schema = Type.Object({ next: Type.Optional(workflowRefSchema()) });
	assert.deepEqual(Value.Decode(schema, {}), {});
	assert.equal(inspectSchema(schema).required, undefined);
});

test("inspection advertises encoded contributions and invocation does not decode them", () => {
	let decodes = 0;
	const contributions = Type.Object({
		records: Type.String(),
		count: Type.Decode(Type.String(), (value) => {
			decodes++;
			return Number(value);
		}),
		label: Type.Optional(Type.String({ default: "collected" })),
	});
	const reference = Type.With(workflowRefSchema({ args: contributions }), {
		description: "Continue with the collected records",
	});
	const schema = Type.Object({ next: reference });
	const inspected = inspectSchema(schema);
	expect(inspected).toHaveProperty(
		"properties.next.x-norn-workflow-ref.contributedArgsSchema",
		inspectSchema(contributions),
	);
	expect(inspected).toHaveProperty(
		"properties.next.description",
		"Continue with the collected records",
	);
	expect(inspected).toHaveProperty(
		"properties.next.anyOf",
		inspectSchema(workflowRefSchema()).anyOf,
	);
	expect(inspected).toHaveProperty(
		"properties.next.anyOf.1.properties.forwardArgs.patternProperties",
		{ "^.*$": {} },
	);
	expect(inspected).toHaveProperty(
		"properties.next.x-norn-workflow-ref.contributedArgsSchema.required",
		["records", "count"],
	);
	expect(inspected).toHaveProperty(
		"properties.next.x-norn-workflow-ref.contributedArgsSchema.properties.count.type",
		"string",
	);
	const forwardArgs = {
		taskId: "task-42",
		nested: { labels: ["one", "two"], enabled: false, absent: null },
	};
	const next = Value.Decode(schema, {
		next: { workflow: "refs.finish", forwardArgs },
	}).next;
	const contribution = { records: "records.json", count: "2" };
	assert.deepEqual(next(contribution).args, {
		...forwardArgs,
		...contribution,
	});
	assert.equal(decodes, 0);
	assert.throws(() =>
		Reflect.apply(next, undefined, [{ records: "records.json", count: 2 }]),
	);
});

test("references without contributions advertise an empty object schema", () => {
	const reference = workflowRefSchema();
	expect(inspectSchema(reference)).toHaveProperty(
		"x-norn-workflow-ref.contributedArgsSchema",
		inspectSchema(Type.Object({})),
	);
	assert.deepEqual(Value.Decode(reference, "refs.finish")({}), {
		type: "next",
		workflowId: "refs.finish",
		args: {},
	});
});

test("optional, nullable and array references retain annotations and callable codecs", () => {
	const reference = workflowRefSchema({
		args: Type.Object({ report: Type.String() }),
	});
	const schema = Type.Object({
		optional: Type.Optional(reference),
		nullable: Type.Union([reference, Type.Null()]),
		many: Type.Array(reference),
	});
	const inspected = inspectSchema(schema);
	for (const path of [
		"properties.optional",
		"properties.nullable.anyOf.0",
		"properties.many.items",
	]) {
		expect(inspected).toHaveProperty(
			`${path}.x-norn-workflow-ref.contributedArgsSchema`,
			inspectSchema(Type.Object({ report: Type.String() })),
		);
	}
	assert.deepEqual(inspected.required, ["nullable", "many"]);
	const decoded = Value.Decode(schema, {
		nullable: null,
		many: ["refs.finish"],
		optional: "refs.finish",
	});
	assert.equal(decoded.nullable, null);
	assert.deepEqual(
		decoded.many[0]({ report: "array" }),
		target({ report: "array" }),
	);
	assert.deepEqual(
		decoded.optional!({ report: "optional" }),
		target({ report: "optional" }),
	);
});

test("nested references retain encoded payloads in contributed parameters", () => {
	const finalContributions = Type.Object({ summary: Type.String() });
	const contributions = Type.Object({
		records: Type.String(),
		next: workflowRefSchema({ args: finalContributions }),
	});
	const reference = workflowRefSchema({ args: contributions });
	expect(inspectSchema(reference)).toHaveProperty(
		"x-norn-workflow-ref.contributedArgsSchema.properties.next.x-norn-workflow-ref.contributedArgsSchema",
		inspectSchema(finalContributions),
	);
	const args = {
		records: "records.json",
		next: { workflow: "refs.finish", forwardArgs: { batch: 1 } },
	};
	const transition = Value.Decode(reference, "intermediate")(args);
	assert.deepEqual(transition.args, args);
	assert.deepEqual(
		Value.Decode(contributions, transition.args).next({ summary: "done" }).args,
		{ batch: 1, summary: "done" },
	);
});

test("recursive contributions use native TypeBox definitions", () => {
	const contributions = Type.Cyclic(
		{
			Contribution: Type.Object({
				label: Type.String(),
				children: Type.Array(Type.Ref("Contribution")),
			}),
		},
		"Contribution",
	);
	const reference = workflowRefSchema({ args: contributions });
	expect(inspectSchema(reference)).toHaveProperty(
		"x-norn-workflow-ref.contributedArgsSchema",
		inspectSchema(contributions),
	);
	const args = { label: "root", children: [{ label: "leaf", children: [] }] };
	assert.deepEqual(Value.Decode(reference, "refs.finish")(args).args, args);
});

test("object-valued unions, records, intersections and root codecs can contribute", () => {
	const union = workflowRefSchema({
		args: Type.Union([
			Type.Object({ kind: Type.Literal("ok"), report: Type.String() }),
			Type.Object({ kind: Type.Literal("error"), reason: Type.String() }),
		]),
	});
	assert.deepEqual(
		Value.Decode(union, "target")({ kind: "error", reason: "failed" }).args,
		{ kind: "error", reason: "failed" },
	);
	const record = workflowRefSchema({
		args: Type.Record(Type.String(), Type.Integer()),
	});
	assert.deepEqual(Value.Decode(record, "target")({ first: 1 }).args, {
		first: 1,
	});
	const intersection = workflowRefSchema({
		args: Type.Intersect([
			Type.Object({ left: Type.String() }),
			Type.Object({ right: Type.Integer() }),
		]),
	});
	assert.deepEqual(
		Value.Decode(intersection, "target")({ left: "x", right: 2 }).args,
		{ left: "x", right: 2 },
	);
	const codec = workflowRefSchema({
		args: Type.Decode(
			Type.Object({ text: Type.String() }),
			(value) => value.text,
		),
	});
	assert.deepEqual(Value.Decode(codec, "target")({ text: "encoded" }).args, {
		text: "encoded",
	});
	const unknown = Value.Decode(
		workflowRefSchema({ args: Type.Unknown() }),
		"target",
	);
	for (const value of [null, [], "text", 1])
		assert.throws(
			() => Reflect.apply(unknown, undefined, [value]),
			/contributions must be objects/,
		);
	for (const value of [new Date(), { callback: () => undefined }])
		assert.throws(() => Reflect.apply(unknown, undefined, [value]));
});

test("non-JSON contributions fail explicit inspection without preventing construction", () => {
	const reference = workflowRefSchema({ args: Type.BigInt() });
	assert.equal(typeof Value.Decode(reference, "refs.finish"), "function");
	assert.throws(() => inspectSchema(reference));
	const nested = workflowRefSchema({ args: Type.Object({ next: reference }) });
	assert.throws(() =>
		inspectSchema(Type.Object({ next: Type.Optional(Type.Array(nested)) })),
	);
});

test("inspection traverses schema positions, not defaults, examples or property-name maps", () => {
	const payload = {
		"x-norn-workflow-ref": { contributedArgsSchema: { type: "bigint" } },
	};
	const schema = Type.Object(
		{ "x-norn-workflow-ref": Type.String() },
		{ default: payload, examples: [payload] },
	);
	assert.doesNotThrow(() => inspectSchema(schema));
	const invalid = workflowRefSchema({ args: Type.BigInt() });
	for (const wrapper of [
		Type.Record(Type.String(), invalid),
		Type.Tuple([invalid]),
		Type.Object({}, { additionalProperties: invalid }),
		Type.Cyclic({ Root: Type.Object({ child: invalid }) }, "Root"),
	]) {
		assert.throws(() => inspectSchema(wrapper));
	}
});

for (const input of [
	undefined,
	null,
	"",
	3,
	{},
	{ workflow: "refs.finish" },
	{ workflow: "", forwardArgs: {} },
	{ workflow: "refs.finish", forwardArgs: null },
	{ workflow: target, forwardArgs: {} },
]) {
	test(`reference input schema rejects invalid shape without coercion: ${JSON.stringify(input)}`, () => {
		assert.equal(Value.Check(workflowRefSchema(), input), false);
	});
}

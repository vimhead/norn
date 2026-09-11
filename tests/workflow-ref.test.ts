import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { z } from "zod";

import { artifactRefSchema, definePluginManifest, workflowRefSchema } from "../src/api.ts";

const target = definePluginManifest({
	id: "refs", workflows: { finish: { isEntrypoint: false, params: z.object({ report: z.string() }) } },
}).workflows.finish;

for (const reference of ["refs.finish", { id: "refs.finish" }, target]) {
	test(`workflow references normalize ${typeof reference === "string" ? "strings" : "kind" in reference ? "declarations" : "id objects"}`, () => {
		const schema = workflowRefSchema({ params: z.object({ report: z.string() }) });
		assert.deepEqual(schema.parse(reference), { workflow: "refs.finish", forwardParams: {} });
		assert.deepEqual(schema.parse({ workflow: reference, forwardParams: { task: "retain" } }), {
			workflow: "refs.finish", forwardParams: { task: "retain" },
		});
	});
}

test("required and nullable reference inputs remain required in JSON inspection", () => {
	const schema = z.object({ next: workflowRefSchema().nullable() });
	const inspected = z.toJSONSchema(schema, { io: "input" });
	assert.deepEqual(inspected.required, ["next"]);
	assert.equal(schema.safeParse({}).success, false);
	assert.equal(schema.safeParse({ next: null }).success, true);
	assert.equal(schema.safeParse({ next: "refs.finish" }).success, true);
	expect(inspected).toHaveProperty("properties.next.anyOf.0.anyOf.0.anyOf.0.type", "string");
	expect(inspected).toHaveProperty("properties.next.anyOf.0.anyOf.1.required", ["workflow", "forwardParams"]);
});

test("optional reference inputs are optional in both validation and inspection", () => {
	const schema = z.object({ next: workflowRefSchema().optional() });
	assert.deepEqual(schema.parse({}), {});
	assert.equal(z.toJSONSchema(schema, { io: "input" }).required?.includes("next") ?? false, false);
});

test("inspection advertises contributions alongside the unchanged reference and forward-params input schema", () => {
	const contributions = z.object({
		records: artifactRefSchema,
		count: z.string().transform(Number),
		label: z.string().default("collected"),
	});
	const reference = workflowRefSchema({ params: contributions }).describe("Continue with the collected records");
	const schema = z.object({ next: reference });
	const inspected = z.toJSONSchema(schema, { io: "input" });
	expect(inspected).toHaveProperty("properties.next.x-norn-workflow-ref.contributedParamsSchema", z.toJSONSchema(contributions, { io: "input" }));
	expect(inspected).toHaveProperty("properties.next.description", "Continue with the collected records");
	expect(inspected).toHaveProperty("properties.next.anyOf", z.toJSONSchema(workflowRefSchema(), { io: "input" }).anyOf);
	expect(inspected).toHaveProperty("properties.next.anyOf.1.properties.forwardParams.type", "object");
	expect(inspected).toHaveProperty("properties.next.anyOf.1.properties.forwardParams.additionalProperties", {});
	expect(inspected).toHaveProperty("properties.next.anyOf.1.required", ["workflow", "forwardParams"]);
	expect(inspected).toHaveProperty("properties.next.x-norn-workflow-ref.contributedParamsSchema.required", ["records", "count"]);
	expect(inspected).toHaveProperty("properties.next.x-norn-workflow-ref.contributedParamsSchema.properties.count.type", "string");
	const forwardParams = { taskId: "task-42", nested: { labels: ["one", "two"], enabled: false, absent: null } };
	const input = { next: { workflow: "refs.finish", forwardParams } };
	assert.deepEqual(schema.parse(input), input);
});

test("references without declared contributions advertise an empty contribution schema", () => {
	for (const reference of [workflowRefSchema(), workflowRefSchema({ params: undefined })]) {
		expect(z.toJSONSchema(reference, { io: "input" })).toHaveProperty("x-norn-workflow-ref.contributedParamsSchema", z.toJSONSchema(z.object({}), { io: "input" }));
		assert.deepEqual(reference.parse("refs.finish"), { workflow: "refs.finish", forwardParams: {} });
	}
});

test("optional, nullable and array references retain their contribution annotations", () => {
	const reference = workflowRefSchema({ params: z.object({ report: z.string() }) });
	const schema = z.object({ optional: reference.optional(), nullable: reference.nullable(), many: z.array(reference) });
	const inspected = z.toJSONSchema(schema, { io: "input" });
	const expected = z.toJSONSchema(z.object({ report: z.string() }), { io: "input" });
	for (const path of ["properties.optional", "properties.nullable.anyOf.0", "properties.many.items"]) {
		expect(inspected).toHaveProperty(`${path}.x-norn-workflow-ref.contributedParamsSchema`, expected);
	}
	assert.deepEqual(inspected.required, ["nullable", "many"]);
	assert.deepEqual(schema.parse({ nullable: null, many: ["refs.finish"] }), { nullable: null, many: [{ workflow: "refs.finish", forwardParams: {} }] });
});

test("nested continuation schemas retain their own contribution and forwarding contracts", () => {
	const finalContributions = z.object({ summary: z.string() });
	const contributions = z.object({
		records: artifactRefSchema,
		next: workflowRefSchema({ params: finalContributions }),
	});
	const inspected = z.toJSONSchema(workflowRefSchema({ params: contributions }), { io: "input" });
	const path = "x-norn-workflow-ref.contributedParamsSchema.properties.next";
	expect(inspected).toHaveProperty(`${path}.x-norn-workflow-ref.contributedParamsSchema`, z.toJSONSchema(finalContributions, { io: "input" }));
	expect(inspected).toHaveProperty(`${path}.anyOf.1.properties.forwardParams.type`, "object");
	expect(inspected).toHaveProperty(`${path}.anyOf.1.properties.forwardParams.additionalProperties`, {});
});

test("lazy recursive contribution schemas are resolved during inspection, not reference construction", () => {
	type Contribution = { label: string; children: Contribution[] };
	let contributions: z.ZodType<Contribution>;
	const lazyContributions = z.lazy(() => contributions);
	const reference = workflowRefSchema({ params: lazyContributions });
	contributions = z.object({ label: z.string(), children: z.array(z.lazy(() => contributions)) });
	const inspected = z.toJSONSchema(reference, { io: "input" });
	expect(inspected).toHaveProperty("x-norn-workflow-ref.contributedParamsSchema", z.toJSONSchema(lazyContributions, { io: "input" }));
	assert.deepEqual(reference.parse("refs.finish"), { workflow: "refs.finish", forwardParams: {} });
});

test("an unrepresentable contribution schema does not change reference parsing", () => {
	const reference = workflowRefSchema({ params: z.custom(() => true) });
	assert.deepEqual(reference.parse("refs.finish"), { workflow: "refs.finish", forwardParams: {} });
	assert.throws(() => z.toJSONSchema(reference, { io: "input" }));
});

for (const input of [undefined, null, "", 3, {}, { id: "" }, { workflow: "refs.finish" }, { workflow: "", forwardParams: {} }, { workflow: "refs.finish", forwardParams: null }]) {
	test(`invalid workflow reference is rejected: ${JSON.stringify(input)}`, () => {
		assert.equal(workflowRefSchema().safeParse(input).success, false);
	});
}

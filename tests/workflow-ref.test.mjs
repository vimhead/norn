import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";
import { z } from "zod";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { definePluginManifest, workflowRefSchema } = await jiti.import("../src/api.ts");

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
	const alternatives = inspected.properties.next.anyOf[0].anyOf;
	assert.equal(alternatives[0].anyOf[0].type, "string");
	assert.deepEqual(alternatives[1].required, ["workflow", "forwardParams"]);
});

test("optional reference inputs are optional in both validation and inspection", () => {
	const schema = z.object({ next: workflowRefSchema().optional() });
	assert.deepEqual(schema.parse({}), {});
	assert.equal(z.toJSONSchema(schema, { io: "input" }).required?.includes("next") ?? false, false);
});

for (const input of [undefined, null, "", 3, {}, { id: "" }, { workflow: "refs.finish" }, { workflow: "", forwardParams: {} }, { workflow: "refs.finish", forwardParams: null }]) {
	test(`invalid workflow reference is rejected: ${JSON.stringify(input)}`, () => {
		assert.equal(workflowRefSchema().safeParse(input).success, false);
	});
}

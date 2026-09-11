import assert from "node:assert/strict";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { default: adapter } = await jiti.import("../adapters/pi.ts");
const { AGENT_RESPONSE_TOOL_NAME } = await jiti.import("../src/internal/agent-response-tool.ts");

function createAdapterFixture() {
	const handlers = new Map();
	const flags = new Map();
	const calls = [];
	const warnings = [];
	const fixture = {
		result: { stdout: JSON.stringify({ intro: "Current Norn introduction" }), stderr: "", code: 0, killed: false },
		tools: [],
		flags, calls, warnings,
		async before(systemPrompt) {
			return handlers.get("before_agent_start")({ systemPrompt }, { cwd: "/task", ui: { notify: (...args) => warnings.push(args) } });
		},
	};
	adapter({
		registerFlag(name, options) { assert.equal(name, "norn-executable"); assert.equal(options.type, "string"); },
		on: (name, handler) => handlers.set(name, handler),
		getAllTools: () => fixture.tools,
		getFlag: name => flags.get(name),
		exec: async (...args) => { calls.push(args); if (fixture.result instanceof Error) throw fixture.result; return fixture.result; },
	});
	return fixture;
}

test("adapter appends to the chained prompt, refreshes each turn, and prevents duplicate blocks", async () => {
	const fixture = createAdapterFixture();
	const base = "Custom system prompt\nEarlier extension content";
	const first = await fixture.before(base);
	assert.equal(first.systemPrompt, `${base}\n\n<norn-docs-intro>\nCurrent Norn introduction\n</norn-docs-intro>`);
	assert.deepEqual(fixture.calls[0], ["norn", ["docs", "intro"], { cwd: "/task", timeout: 10_000 }]);
	assert.equal(await fixture.before(first.systemPrompt), undefined);
	assert.equal(fixture.calls.length, 1);
	fixture.result.stdout = JSON.stringify({ intro: "Changed Norn introduction" });
	const next = await fixture.before(base);
	assert.ok(next.systemPrompt.includes("Changed Norn introduction"));
	assert.ok(!next.systemPrompt.includes("Current Norn introduction"));
	assert.equal(fixture.calls.length, 2);
	assert.equal(fixture.warnings.length, 0);
});

test("explicit executable paths are passed as executable names, never shell commands", async () => {
	const fixture = createAdapterFixture();
	fixture.flags.set("norn-executable", "/other installation/norn");
	await fixture.before("base");
	assert.equal(fixture.calls[0][0], "/other installation/norn");
});

test("registered native response tools exclude workers without invoking the CLI", async () => {
	const fixture = createAdapterFixture();
	fixture.tools = [{ name: AGENT_RESPONSE_TOOL_NAME }];
	assert.equal(await fixture.before("Source-only worker prompt"), undefined);
	assert.equal(fixture.calls.length, 0);
	assert.equal(fixture.warnings.length, 0);
});

for (const [label, result] of [
	["missing executable", new Error("secret diagnostic")],
	["nonzero exit", { stdout: "secret diagnostic", code: 1, killed: false }],
	["timeout", { stdout: '{"intro":"partial"}', code: 0, killed: true }],
	["invalid JSON", { stdout: "secret diagnostic", code: 0, killed: false }],
	["null response", { stdout: "null", code: 0, killed: false }],
	["missing intro", { stdout: "{}", code: 0, killed: false }],
	["wrong intro type", { stdout: '{"intro":42}', code: 0, killed: false }],
	["empty intro", { stdout: '{"intro":"  "}', code: 0, killed: false }],
	["oversized intro", { stdout: JSON.stringify({ intro: "a".repeat(16_385) }), code: 0, killed: false }],
]) {
	test(`${label} preserves the prompt, warns once, and permits later recovery`, async () => {
		const fixture = createAdapterFixture();
		fixture.result = result;
		assert.equal(await fixture.before("base"), undefined);
		assert.equal(await fixture.before("base"), undefined);
		assert.equal(fixture.warnings.length, 1);
		assert.ok(!JSON.stringify(fixture.warnings).includes("secret diagnostic"));
		fixture.result = { stdout: '{"intro":"recovered"}', code: 0, killed: false };
		assert.ok((await fixture.before("base")).systemPrompt.includes("recovered"));
		fixture.result = result;
		await fixture.before("base");
		assert.equal(fixture.warnings.length, 2);
	});
}

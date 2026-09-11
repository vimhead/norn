import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi, type TestContext } from "vitest";
import { DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, type ExecResult, type ExtensionAPI, type ExtensionUIContext, type ToolInfo } from "@earendil-works/pi-coding-agent";
import adapter from "../adapters/pi.ts";
import { AGENT_RESPONSE_TOOL_NAME } from "../src/internal/agent-response-tool.ts";

type AdapterFixture = {
	cwd: string;
	result: ExecResult | Error;
	tools: ToolInfo[];
	flags: Map<string, string | boolean>;
	calls: Parameters<ExtensionAPI["exec"]>[];
	warnings: Parameters<ExtensionUIContext["notify"]>[];
	before(systemPrompt: string): ReturnType<ExtensionRunner["emitBeforeAgentStart"]>;
};

async function createAdapterFixture(context: TestContext): Promise<AdapterFixture> {
	const cwd = await mkdtemp(join(tmpdir(), "norn-adapter-unit-"));
	context.onTestFinished(() => rm(cwd, { recursive: true, force: true }));
	context.onTestFinished(() => { vi.restoreAllMocks(); });
	let runner: ExtensionRunner;
	const fixture: AdapterFixture = {
		cwd,
		result: { stdout: JSON.stringify({ intro: "Current Norn introduction" }), stderr: "", code: 0, killed: false },
		tools: [], flags: new Map(), calls: [], warnings: [],
		before: systemPrompt => runner.emitBeforeAgentStart("task", undefined, systemPrompt, { cwd }),
	};
	const loader = new DefaultResourceLoader({
		cwd, agentDir: cwd, settingsManager: SettingsManager.inMemory(),
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		agentsFilesOverride: () => ({ agentsFiles: [] }),
		extensionFactories: [{ name: "norn-adapter", factory: pi => {
			vi.spyOn(pi, "getAllTools").mockImplementation(() => fixture.tools);
			vi.spyOn(pi, "getFlag").mockImplementation(name => fixture.flags.get(name));
			vi.spyOn(pi, "exec").mockImplementation(async (...args) => {
				fixture.calls.push(args);
				if (fixture.result instanceof Error) throw fixture.result;
				return fixture.result;
			});
			adapter(pi);
		} }],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions[0].flags.get("norn-executable")?.type, "string");
	const models = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });
	runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, SessionManager.inMemory(cwd), new ModelRegistry(models));
	runner.setUIContext({ ...runner.getUIContext(), notify: (...args) => { fixture.warnings.push(args); } });
	return fixture;
}

test("adapter caches the introduction while preserving each turn's chained prompt and preventing duplicate blocks", async context => {
	const fixture = await createAdapterFixture(context);
	const base = "Custom system prompt\nEarlier extension content";
	const first = await fixture.before(base);
	assert.ok(first?.systemPrompt);
	assert.equal(first.systemPrompt, `${base}\n\n<norn-docs-intro>\nCurrent Norn introduction\n</norn-docs-intro>`);
	assert.deepEqual(fixture.calls[0], ["norn", ["docs", "intro"], { cwd: fixture.cwd, timeout: 10_000 }]);
	assert.equal(await fixture.before(first.systemPrompt), undefined);
	assert.equal(fixture.calls.length, 1);
	fixture.result = { stdout: JSON.stringify({ intro: "Changed Norn introduction" }), stderr: "", code: 0, killed: false };
	const nextBase = "Changed system prompt\nNew extension content";
	const next = await fixture.before(nextBase);
	assert.equal(next?.systemPrompt, `${nextBase}\n\n<norn-docs-intro>\nCurrent Norn introduction\n</norn-docs-intro>`);
	assert.equal(fixture.calls.length, 1);
	assert.equal(fixture.warnings.length, 0);
});

test("explicit executable paths are passed as executable names, never shell commands", async context => {
	const fixture = await createAdapterFixture(context);
	fixture.flags.set("norn-executable", "/other installation/norn");
	await fixture.before("base");
	assert.equal(fixture.calls[0][0], "/other installation/norn");
});

test("registered native response tools exclude workers even with a cached introduction", async context => {
	const fixture = await createAdapterFixture(context);
	fixture.tools = [{ name: AGENT_RESPONSE_TOOL_NAME, description: "Structured worker response", parameters: { type: "object" }, sourceInfo: { path: "<test-response-tool>", source: "custom", scope: "temporary", origin: "top-level" } }];
	assert.equal(await fixture.before("Source-only worker prompt"), undefined);
	assert.equal(fixture.calls.length, 0);
	const workerTools = fixture.tools;
	fixture.tools = [];
	assert.ok((await fixture.before("Outer authoring prompt"))?.systemPrompt);
	fixture.tools = workerTools;
	assert.equal(await fixture.before("Source-only worker prompt"), undefined);
	assert.equal(fixture.calls.length, 1);
	assert.equal(fixture.warnings.length, 0);
});

test("changing the executable discards the previous introduction even when the new runtime fails", async context => {
	const fixture = await createAdapterFixture(context);
	assert.ok((await fixture.before("base"))?.systemPrompt?.includes("Current Norn introduction"));
	fixture.flags.set("norn-executable", "/missing/norn");
	fixture.result = new Error("unavailable runtime");
	assert.equal(await fixture.before("base"), undefined);
	assert.equal(fixture.calls.length, 2);
	assert.equal(fixture.calls[1][0], "/missing/norn");
	fixture.flags.delete("norn-executable");
	fixture.result = { stdout: '{"intro":"Reselected runtime introduction"}', stderr: "", code: 0, killed: false };
	assert.ok((await fixture.before("base"))?.systemPrompt?.includes("Reselected runtime introduction"));
	assert.equal(fixture.calls.length, 3);
	assert.equal(fixture.calls[2][0], "norn");
	await fixture.before("another task");
	assert.equal(fixture.calls.length, 3);
});

const failures: [string, ExecResult | Error][] = [
	["missing executable", new Error("secret diagnostic")],
	["nonzero exit", { stdout: "secret diagnostic", stderr: "", code: 1, killed: false }],
	["timeout", { stdout: '{"intro":"partial"}', stderr: "", code: 0, killed: true }],
	["invalid JSON", { stdout: "secret diagnostic", stderr: "", code: 0, killed: false }],
	["null response", { stdout: "null", stderr: "", code: 0, killed: false }],
	["missing intro", { stdout: "{}", stderr: "", code: 0, killed: false }],
	["wrong intro type", { stdout: '{"intro":42}', stderr: "", code: 0, killed: false }],
	["empty intro", { stdout: '{"intro":"  "}', stderr: "", code: 0, killed: false }],
	["oversized intro", { stdout: JSON.stringify({ intro: "a".repeat(16_385) }), stderr: "", code: 0, killed: false }],
];

for (const [label, result] of failures) {
	test(`${label} preserves the prompt, warns once, and permits later recovery`, async context => {
		const fixture = await createAdapterFixture(context);
		fixture.result = result;
		assert.equal(await fixture.before("base"), undefined);
		assert.equal(await fixture.before("base"), undefined);
		assert.equal(fixture.warnings.length, 1);
		assert.ok(!JSON.stringify(fixture.warnings).includes("secret diagnostic"));
		fixture.result = { stdout: '{"intro":"recovered"}', stderr: "", code: 0, killed: false };
		assert.ok((await fixture.before("base"))?.systemPrompt?.includes("recovered"));
		fixture.result = result;
		assert.ok((await fixture.before("base"))?.systemPrompt?.includes("recovered"));
		assert.equal(fixture.calls.length, 3);
		fixture.flags.set("norn-executable", "/other/norn");
		assert.equal(await fixture.before("base"), undefined);
		assert.equal(fixture.warnings.length, 2);
	});
}

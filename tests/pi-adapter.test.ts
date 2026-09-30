import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi, type TestContext } from "vitest";
import {
	DefaultResourceLoader,
	ExtensionRunner,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExecResult,
	type ExtensionAPI,
	type ExtensionUIContext,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import adapter from "../packages/pi-norn/src/index.ts";
import { AGENT_RESPONSE_TOOL_NAME } from "@vimhead.dev/norn-core/agent-protocol";
import {
	writeLocalRuntime,
	writeRuntimeConfiguration,
} from "./helpers/local-runtime.ts";

type AdapterFixture = {
	cwd: string;
	result: ExecResult | Error;
	workflowsResult: ExecResult | Error;
	isProjectTrusted: boolean;
	tools: ToolInfo[];
	flags: Map<string, string | boolean>;
	calls: Parameters<ExtensionAPI["exec"]>[];
	warnings: Parameters<ExtensionUIContext["notify"]>[];
	start(): Promise<void>;
	before(systemPrompt: string): Promise<{ systemPrompt: string } | undefined>;
};

async function createAdapterFixture(
	context: TestContext,
): Promise<AdapterFixture> {
	const cwd = await mkdtemp(join(tmpdir(), "norn-adapter-unit-"));
	context.onTestFinished(() => rm(cwd, { recursive: true, force: true }));
	context.onTestFinished(() => {
		vi.restoreAllMocks();
	});
	let runner: ExtensionRunner;
	const fixture: AdapterFixture = {
		cwd,
		result: {
			stdout: JSON.stringify({ intro: "Current Norn introduction" }),
			stderr: "",
			code: 0,
			killed: false,
		},
		workflowsResult: {
			stdout: '{"intro":""}',
			stderr: "",
			code: 0,
			killed: false,
		},
		isProjectTrusted: true,
		tools: [],
		flags: new Map(),
		calls: [],
		warnings: [],
		start: () => runner.emit({ type: "session_start", reason: "startup" }),
		before: async (systemPrompt) => {
			const result = await runner.emitBeforeAgentStart("task", undefined, {
				cwd,
				forceSystemPrompt: systemPrompt,
			});
			const updatedPrompt = result.systemPromptOptions.forceSystemPrompt;
			return updatedPrompt !== undefined && updatedPrompt !== systemPrompt
				? { systemPrompt: updatedPrompt }
				: undefined;
		},
	};
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager: SettingsManager.inMemory(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		agentsFilesOverride: () => ({ agentsFiles: [] }),
		extensionFactories: [
			{
				name: "norn-adapter",
				factory: (pi) => {
					vi.spyOn(pi, "getAllTools").mockImplementation(() => fixture.tools);
					vi.spyOn(pi, "getFlag").mockImplementation((name) =>
						fixture.flags.get(name),
					);
					vi.spyOn(pi, "exec").mockImplementation(async (...args) => {
						fixture.calls.push(args);
						const result =
							args[1].at(-2) === "workflows"
								? fixture.workflowsResult
								: fixture.result;
						if (result instanceof Error) throw result;
						return result;
					});
					adapter(pi);
				},
			},
		],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	assert.equal(
		loaded.extensions[0].flags.get("norn-executable")?.type,
		"string",
	);
	const models = await ModelRuntime.create({
		authPath: join(cwd, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(cwd, "models-cache.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		cwd,
		SessionManager.inMemory(cwd),
		new ModelRegistry(models),
	);
	const createContext = runner.createContext.bind(runner);
	vi.spyOn(runner, "createContext").mockImplementation(() =>
		Object.assign(createContext(), {
			isProjectTrusted: () => fixture.isProjectTrusted,
		}),
	);
	runner.setUIContext({
		...runner.getUIContext(),
		notify: (...args) => {
			fixture.warnings.push(args);
		},
	});
	return fixture;
}

test("adapter loads at session start and only appends cached context when a prompt is submitted", async (context) => {
	const fixture = await createAdapterFixture(context);
	const base = "Custom system prompt\nEarlier extension content";
	assert.equal(await fixture.before(base), undefined);
	assert.equal(fixture.calls.length, 0);
	await fixture.start();
	assert.equal(fixture.calls.length, 2);
	const first = await fixture.before(base);
	assert.ok(first?.systemPrompt);
	assert.equal(
		first.systemPrompt,
		`${base}\n\n<norn-docs-intro>\nCurrent Norn introduction\n</norn-docs-intro>`,
	);
	assert.deepEqual(fixture.calls[0], [
		"norn",
		["docs", "intro"],
		{ cwd: fixture.cwd, timeout: 10_000 },
	]);
	assert.deepEqual(fixture.calls[1], [
		"norn",
		["workflows", "intro"],
		{ cwd: fixture.cwd, timeout: 10_000 },
	]);
	assert.equal(await fixture.before(first.systemPrompt), undefined);
	assert.equal(fixture.calls.length, 2);
	fixture.result = {
		stdout: JSON.stringify({ intro: "Changed Norn introduction" }),
		stderr: "",
		code: 0,
		killed: false,
	};
	const nextBase = "Changed system prompt\nNew extension content";
	const next = await fixture.before(nextBase);
	assert.equal(
		next?.systemPrompt,
		`${nextBase}\n\n<norn-docs-intro>\nCurrent Norn introduction\n</norn-docs-intro>`,
	);
	assert.equal(fixture.calls.length, 2);
	assert.equal(fixture.warnings.length, 0);
});

test("explicit executable paths are passed as executable names, never shell commands", async (context) => {
	const fixture = await createAdapterFixture(context);
	fixture.flags.set("norn-executable", "/other installation/norn");
	await fixture.start();
	assert.equal(fixture.calls[0][0], "/other installation/norn");
});

test("project configuration selects local CLI argv while preserving session cwd and refreshes on reload", async (context) => {
	const fixture = await createAdapterFixture(context);
	const { scriptPath } = await writeLocalRuntime({
		packageRoot: join(fixture.cwd, "tools with spaces/owner"),
	});
	await writeRuntimeConfiguration({
		directory: fixture.cwd,
		packageRoot: "./tools with spaces/owner",
	});
	await fixture.start();
	const canonicalScript = await realpath(scriptPath);
	assert.deepEqual(
		fixture.calls,
		["docs", "workflows"].map((group) => [
			process.execPath,
			[canonicalScript, group, "intro"],
			{ cwd: fixture.cwd, timeout: 10_000 },
		]),
	);
	assert.ok(
		(await fixture.before("base"))?.systemPrompt?.includes(
			"Current Norn introduction",
		),
	);
	assert.equal(fixture.warnings.length, 0);
	await writeRuntimeConfiguration({
		directory: fixture.cwd,
		packageRoot: "./missing",
	});
	await fixture.start();
	assert.equal(await fixture.before("base"), undefined);
	assert.equal(fixture.calls.length, 2);
	assert.match(fixture.warnings[0][0], /package.json/);
});

test("untrusted projects ignore even malformed runtime configuration and invalidate trusted cached context", async (context) => {
	const fixture = await createAdapterFixture(context);
	await fixture.start();
	fixture.isProjectTrusted = false;
	assert.equal(await fixture.before("base"), undefined);
	await writeFile(join(fixture.cwd, ".nornrc.json"), "invalid JSON");
	await fixture.start();
	assert.deepEqual(fixture.calls[2], [
		"norn",
		["docs", "intro"],
		{ cwd: fixture.cwd, timeout: 10_000 },
	]);
	assert.equal(fixture.calls.length, 3);
	assert.ok((await fixture.before("base"))?.systemPrompt);
	assert.equal(fixture.warnings.length, 1);
});

test("registered native response tools exclude workers even with a cached introduction", async (context) => {
	const fixture = await createAdapterFixture(context);
	fixture.tools = [
		{
			name: AGENT_RESPONSE_TOOL_NAME,
			exposure: "direct",
			description: "Structured worker response",
			parameters: { type: "object" },
			sourceInfo: {
				path: "<test-response-tool>",
				source: "custom",
				scope: "temporary",
				origin: "top-level",
			},
		},
	];
	await fixture.start();
	assert.equal(await fixture.before("Source-only worker prompt"), undefined);
	assert.equal(fixture.calls.length, 0);
	const workerTools = fixture.tools;
	fixture.tools = [];
	await fixture.start();
	assert.ok((await fixture.before("Outer authoring prompt"))?.systemPrompt);
	fixture.tools = workerTools;
	assert.equal(await fixture.before("Source-only worker prompt"), undefined);
	assert.equal(fixture.calls.length, 2);
	assert.equal(fixture.warnings.length, 0);
});

test("changing the executable invalidates context without running a subprocess at prompt submission", async (context) => {
	const fixture = await createAdapterFixture(context);
	await fixture.start();
	assert.ok(
		(await fixture.before("base"))?.systemPrompt?.includes(
			"Current Norn introduction",
		),
	);
	fixture.flags.set("norn-executable", "/missing/norn");
	fixture.result = new Error("unavailable runtime");
	assert.equal(await fixture.before("base"), undefined);
	assert.equal(await fixture.before("another task"), undefined);
	assert.equal(fixture.calls.length, 2);
	assert.equal(fixture.warnings.length, 1);
	assert.ok(fixture.warnings[0][0].includes("/reload"));
	await fixture.start();
	assert.equal(await fixture.before("base"), undefined);
	assert.equal(fixture.calls.length, 4);
	assert.equal(fixture.calls[2][0], "/missing/norn");
	fixture.flags.delete("norn-executable");
	fixture.result = {
		stdout: '{"intro":"Reselected runtime introduction"}',
		stderr: "",
		code: 0,
		killed: false,
	};
	await fixture.start();
	assert.ok(
		(await fixture.before("base"))?.systemPrompt?.includes(
			"Reselected runtime introduction",
		),
	);
	assert.equal(fixture.calls.length, 6);
	assert.equal(fixture.calls[4][0], "norn");
	await fixture.before("another task");
	assert.equal(fixture.calls.length, 6);
});

test("adapter delivers runtime workflow XML verbatim and refreshes or removes it at session start", async (context) => {
	const fixture = await createAdapterFixture(context);
	const intro =
		"Runtime selection guidance\n<available_norn_workflows>\n  <workflow><id>example.brief</id><instructions>Use when researching.</instructions></workflow>\n</available_norn_workflows>";
	fixture.workflowsResult = {
		stdout: JSON.stringify({ intro }),
		stderr: "",
		code: 0,
		killed: false,
	};
	await fixture.start();
	const first = await fixture.before("Custom prompt");
	assert.equal(
		first?.systemPrompt,
		`Custom prompt\n\n<norn-docs-intro>\nCurrent Norn introduction\n</norn-docs-intro>\n\n${intro}`,
	);
	assert.equal(await fixture.before(first!.systemPrompt!), undefined);
	fixture.workflowsResult = {
		stdout: '{"intro":""}',
		stderr: "",
		code: 0,
		killed: false,
	};
	assert.ok(
		(await fixture.before("Custom prompt"))?.systemPrompt?.includes(intro),
	);
	await fixture.start();
	assert.equal(
		(await fixture.before("Custom prompt"))?.systemPrompt,
		"Custom prompt\n\n<norn-docs-intro>\nCurrent Norn introduction\n</norn-docs-intro>",
	);
	assert.equal(fixture.warnings.length, 0);
});

test("untrusted Pi projects receive documentation without importing workflow modules", async (context) => {
	const fixture = await createAdapterFixture(context);
	fixture.isProjectTrusted = false;
	fixture.workflowsResult = new Error("Project modules must not load");
	await fixture.start();
	assert.deepEqual(
		fixture.calls.map((call) => call[1]),
		[["docs", "intro"]],
	);
	assert.ok(
		(await fixture.before("base"))?.systemPrompt?.includes(
			"Current Norn introduction",
		),
	);
	assert.equal(fixture.warnings.length, 0);
});

const failures: [string, ExecResult | Error][] = [
	["missing executable", new Error("secret diagnostic")],
	[
		"nonzero exit",
		{ stdout: "secret diagnostic", stderr: "", code: 1, killed: false },
	],
	[
		"timeout",
		{ stdout: '{"intro":"partial"}', stderr: "", code: 0, killed: true },
	],
	[
		"invalid JSON",
		{ stdout: "secret diagnostic", stderr: "", code: 0, killed: false },
	],
	["null response", { stdout: "null", stderr: "", code: 0, killed: false }],
	["missing intro", { stdout: "{}", stderr: "", code: 0, killed: false }],
	[
		"wrong intro type",
		{ stdout: '{"intro":42}', stderr: "", code: 0, killed: false },
	],
	[
		"empty intro",
		{ stdout: '{"intro":"  "}', stderr: "", code: 0, killed: false },
	],
	[
		"oversized intro",
		{
			stdout: JSON.stringify({ intro: "a".repeat(16_385) }),
			stderr: "",
			code: 0,
			killed: false,
		},
	],
];

for (const [label, result] of failures) {
	if (label !== "empty intro") {
		test(`workflow ${label} surfaces a failure without partial context`, async (context) => {
			const fixture = await createAdapterFixture(context);
			fixture.workflowsResult = result;
			await fixture.start();
			assert.equal(await fixture.before("base"), undefined);
			assert.equal(fixture.warnings.length, 1);
			assert.ok(fixture.warnings[0][0].includes("workflows intro"));
			assert.ok(
				!JSON.stringify(fixture.warnings).includes("secret diagnostic"),
			);
		});
	}
	test(`${label} warns at startup without retrying on prompts and permits recovery at the next session start`, async (context) => {
		const fixture = await createAdapterFixture(context);
		fixture.result = result;
		await fixture.start();
		assert.equal(await fixture.before("base"), undefined);
		assert.equal(await fixture.before("base"), undefined);
		assert.equal(fixture.warnings.length, 1);
		assert.ok(fixture.warnings[0][0].includes("/reload"));
		assert.ok(!JSON.stringify(fixture.warnings).includes("secret diagnostic"));
		fixture.result = {
			stdout: '{"intro":"recovered"}',
			stderr: "",
			code: 0,
			killed: false,
		};
		assert.equal(await fixture.before("base"), undefined);
		assert.equal(fixture.calls.length, 2);
		await fixture.start();
		assert.ok(
			(await fixture.before("base"))?.systemPrompt?.includes("recovered"),
		);
		fixture.result = result;
		assert.ok(
			(await fixture.before("base"))?.systemPrompt?.includes("recovered"),
		);
		assert.equal(fixture.calls.length, 4);
		await fixture.start();
		assert.equal(await fixture.before("base"), undefined);
		assert.equal(fixture.calls.length, 6);
		assert.equal(fixture.warnings.length, 2);
	});
}

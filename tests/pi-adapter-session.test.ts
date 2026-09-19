import { createStateTools } from "../examples/shared-state/state-tools.ts";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { AgentSession, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createRunFileCoordinator } from "@vimhead.dev/norn/files";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { test, vi, type TestContext } from "vitest";

import type { NornWorkflowCatalogInfo, NornWorkflowInspection, ToolDefinition } from "@vimhead.dev/norn";
import { AGENT_RESPONSE_TOOL_NAME } from "@vimhead.dev/norn-core/agent-protocol";
import { NornAgentResponseCollector } from "../packages/cli/src/internal/agent-response-tool.ts";
import { NornAgentRunner } from "../packages/cli/src/internal/agents.ts";
import { NornRunLogs } from "../packages/cli/src/internal/logs.ts";
import { NornRunLogger } from "../packages/cli/src/internal/run-log.ts";
import { initializeSharedState } from "./helpers/shared-state.ts";
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const model: Model<"anthropic-messages"> = { id: "offline", name: "Offline test", provider: "offline-test", api: "anthropic-messages", baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

async function createFixture(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "norn-pi-adapter-"));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "task");
	const agentDir = join(root, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const home = join(root, "home");
	await mkdir(home);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousHome = process.env.HOME;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.HOME = home;
	context.onTestFinished(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
	});
	return { root, cwd, agentDir };
}

type CapturedRequest = { systemPrompt: string; tools: string[] };

function lastRequest(captured: readonly CapturedRequest[]): CapturedRequest {
	const request = captured.at(-1);
	assert.ok(request, "the model stream received a request");
	return request;
}

function captureModelRequests(session: AgentSession, captured: CapturedRequest[], resourceCalls: readonly { name: string; arguments: Record<string, unknown> }[] = []) {
	let nextCall = 0;
	session.modelRuntime.hasConfiguredAuth = () => true;
	session.agent.streamFunction = (_model, context) => {
		assert.ok(context.systemPrompt);
		const tools = context.tools ?? [];
		captured.push({ systemPrompt: context.systemPrompt, tools: tools.map(tool => tool.name) });
		const stream = new AssistantMessageEventStream();
		const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: "Offline response" }], stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		if (tools.some(tool => tool.name === AGENT_RESPONSE_TOOL_NAME)) {
			const userMessage = context.messages.filter(message => message.role === "user").at(-1);
			assert.ok(userMessage);
			const prompt = userMessage.content;
			const text = typeof prompt === "string" ? prompt : prompt.filter(part => part.type === "text").map(part => part.text).join("\n");
			const runId = text.match(/Pass runId exactly as: (.+)/);
			const label = text.match(/Pass label exactly as: (.+)/);
			assert.ok(runId && label);
			message.content = [{ type: "toolCall", id: "offline-response", name: AGENT_RESPONSE_TOOL_NAME, arguments: { runId: runId[1], label: label[1], response: { ok: true } } }];
			message.stopReason = "toolUse";
		}
		const resourceCall = resourceCalls[nextCall++];
		if (resourceCall) {
			assert.ok(tools.some(tool => tool.name === resourceCall.name), `Attached tool is active: ${resourceCall.name}`);
			message.content = [{ type: "toolCall", id: `resource-${nextCall}`, ...resourceCall }];
			message.stopReason = "toolUse";
		}
		stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
		stream.end(message);
		return stream;
	};
}

async function writeExecutable(path: string, source: string) {
	await writeFile(path, `#!/usr/bin/env node\n${source}\n`);
	await chmod(path, 0o700);
}

test("Pi loads runtime-selected context before the first prompt and refreshes it on reload", { skip: process.platform === "win32", timeout: 60_000 }, async context => {
	const fixture = await createFixture(context);
	const runtimeRoot = join(fixture.root, "other installation");
	await mkdir(runtimeRoot);
	for (const path of ["dist", "bin", "assets", "package.json"]) await cp(join(packageRoot, "packages/cli", path), join(runtimeRoot, path), { recursive: true });
	await symlink(join(packageRoot, "node_modules"), join(runtimeRoot, "node_modules"));
	const documentationManifest = join(runtimeRoot, "assets/package.json");
	const manifest = JSON.parse(await readFile(documentationManifest, "utf8"));
	manifest.version = "9.9.9";
	await writeFile(documentationManifest, JSON.stringify(manifest));
	const runtimeManifestPath = join(runtimeRoot, "package.json");
	const runtimeManifest = JSON.parse(await readFile(runtimeManifestPath, "utf8"));
	await writeFile(runtimeManifestPath, JSON.stringify({ ...runtimeManifest, version: manifest.version }));
	const shadow = join(fixture.root, "shadow");
	await mkdir(shadow);
	await writeExecutable(join(shadow, "norn"), 'process.stdout.write(JSON.stringify({intro:"PATH runtime introduction"}));');
	const previousPath = process.env.PATH;
	process.env.PATH = `${shadow}${delimiter}${previousPath}`;
	context.onTestFinished(() => { process.env.PATH = previousPath; });

	const directIntro = JSON.parse(execFileSync(join(runtimeRoot, "bin/norn.mjs"), ["docs", "intro"], { cwd: fixture.cwd, encoding: "utf8" }));
	assert.ok(directIntro.intro.includes('Version: "9.9.9"'));
	const settingsManager = SettingsManager.inMemory({ packages: [join(packageRoot, "packages/pi-norn")], compaction: { enabled: false }, retry: { enabled: false } });
	let useCustomPrompt = true;
	const loader = new DefaultResourceLoader({
		cwd: fixture.cwd, agentDir: fixture.agentDir, settingsManager,
		systemPromptOverride: base => useCustomPrompt ? "CUSTOM SYSTEM PROMPT" : base,
		agentsFilesOverride: () => ({ agentsFiles: [{ path: join(fixture.cwd, "AGENTS.md"), content: "PROJECT CONTEXT" }] }),
		extensionFactories: [{ name: "other-prompt-extension", factory: pi => { pi.on("before_agent_start", event => ({ systemPrompt: event.systemPrompt + "\nOTHER EXTENSION" })); } }],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	assert.ok(loader.getExtensions().extensions.some(extension => extension.path.endsWith("pi-norn/dist/index.js")));
	const { session } = await createAgentSession({ cwd: fixture.cwd, agentDir: fixture.agentDir, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(fixture.cwd), model, tools: ["read"] });
	context.onTestFinished(() => session.dispose());
	loader.getExtensions().runtime.flagValues.set("norn-executable", join(runtimeRoot, "bin/norn.mjs"));
	const captured: CapturedRequest[] = [];
	captureModelRequests(session, captured);
	await session.bindExtensions({ uiContext: session.extensionRunner.getUIContext() });
	manifest.version = "9.9.10";
	await writeFile(documentationManifest, JSON.stringify(manifest));
	await writeFile(runtimeManifestPath, JSON.stringify({ ...runtimeManifest, version: manifest.version }));
	await session.prompt("First ordinary task");
	const first = lastRequest(captured).systemPrompt;
	assert.ok(first.startsWith("CUSTOM SYSTEM PROMPT"));
	assert.ok(first.includes("PROJECT CONTEXT"));
	assert.ok(first.includes("OTHER EXTENSION"));
	assert.ok(first.includes('Version: "9.9.9"'), first);
	assert.ok(first.includes("other installation/assets/docs/README.md"));
	assert.ok(!first.includes("PATH runtime introduction"));
	assert.equal(first.split("<norn-docs-intro>").length - 1, 1);
	assert.ok(first.includes(directIntro.intro));
	const runtimeLine = first.match(/^Runtime argv .*: (.+)$/m);
	assert.ok(runtimeLine);
	const invocation: [string, ...string[]] = JSON.parse(runtimeLine[1]);
	const invoke = <Output>(args: readonly string[]): Output => JSON.parse(execFileSync(invocation[0], [...invocation.slice(1), ...args], { cwd: fixture.cwd, encoding: "utf8", timeout: 30_000 }));
	await writeFile(join(fixture.cwd, "norn.project.json"), JSON.stringify({ version: 1, workflows: [] }));
	assert.deepEqual(invoke<NornWorkflowCatalogInfo>(["workflows", "list"]).workflows, []);
	const plugin = (await readFile(join(packageRoot, "examples/minimal-workflow/plugin.ts"), "utf8")).replace('id: "greeting.write"', 'id: "fresh.write"');
	await writeFile(join(fixture.cwd, "plugin.ts"), plugin);
	await writeFile(join(fixture.cwd, "norn.project.json"), JSON.stringify({ version: 1, workflows: ["./plugin.ts"] }));
	assert.deepEqual(invoke<NornWorkflowCatalogInfo>(["workflows", "list"]).workflows.map(workflow => workflow.id), ["fresh.write"]);
	const inspection = invoke<NornWorkflowInspection>(["workflows", "inspect", "fresh.write"]);
	assert.ok(inspection.workflow);
	assert.equal(inspection.workflow.id, "fresh.write");
	assert.deepEqual(inspection.workflow.argsSchema.required, ["name"]);
	assert.ok(!first.includes("fresh.write"));

	await session.prompt("Next ordinary task");
	assert.ok(lastRequest(captured).systemPrompt.includes('Version: "9.9.9"'));
	assert.ok(!lastRequest(captured).systemPrompt.includes('Version: "9.9.10"'));
	const unrelatedSkillPath = join(fixture.agentDir, "skills/test-guidance/SKILL.md");
	await mkdir(join(fixture.agentDir, "skills/test-guidance"), { recursive: true });
	await writeFile(unrelatedSkillPath, "---\nname: test-guidance\ndescription: Use when exercising the unrelated skill fixture.\n---\n\n# Test guidance\n");
	await session.reload();
	await session.prompt("Task after reload");
	assert.deepEqual(loader.getSkills().skills.map(skill => skill.name), ["test-guidance"]);
	assert.ok(lastRequest(captured).systemPrompt.includes(unrelatedSkillPath));
	assert.equal(lastRequest(captured).systemPrompt.split("<norn-docs-intro>").length - 1, 1);
	assert.ok(lastRequest(captured).systemPrompt.includes('Version: "9.9.10"'));
	assert.ok(!lastRequest(captured).systemPrompt.includes('Version: "9.9.9"'));

	useCustomPrompt = false;
	await session.reload();
	await session.prompt("Task with Pi's default prompt");
	assert.ok(lastRequest(captured).systemPrompt.startsWith("You are an expert coding assistant"));
	assert.ok(lastRequest(captured).systemPrompt.includes("Pi documentation"));
	assert.ok(lastRequest(captured).systemPrompt.includes("<available_skills>"));
	assert.equal(lastRequest(captured).systemPrompt.split("<norn-docs-intro>").length - 1, 1);
	loader.getExtensions().runtime.flagValues.delete("norn-executable");
	await session.prompt("Task before reloading the changed runtime selection");
	assert.ok(!lastRequest(captured).systemPrompt.includes("<norn-docs-intro>"));
	await session.reload();
	await session.prompt("Use the PATH runtime now");
	assert.ok(lastRequest(captured).systemPrompt.includes("PATH runtime introduction"));
	assert.ok(!lastRequest(captured).systemPrompt.includes('Version: "9.9.10"'));
	loader.getExtensions().runtime.flagValues.set("norn-executable", join(fixture.root, "missing-executable"));
	await session.reload();
	await session.prompt("Task with an unavailable runtime");
	assert.ok(lastRequest(captured).systemPrompt.includes("PROJECT CONTEXT"));
	assert.ok(!lastRequest(captured).systemPrompt.includes("<norn-docs-intro>"));
	assert.ok(!lastRequest(captured).systemPrompt.includes("PATH runtime introduction"));
});

test("a real native Norn worker excludes the adapter, including after reload with its response tool inactive", { skip: process.platform === "win32", timeout: 30_000 }, async context => {
	const fixture = await createFixture(context);
	await writeFile(join(fixture.agentDir, "settings.json"), JSON.stringify({ packages: [join(packageRoot, "packages/pi-norn")], compaction: { enabled: false }, retry: { enabled: false } }));
	const calledPath = join(fixture.root, "cli-called");
	const executable = join(fixture.root, "norn");
	await writeExecutable(executable, `require("node:fs").writeFileSync(${JSON.stringify(calledPath)}, "called"); process.stdout.write(JSON.stringify({intro:"UNWANTED AUTHORING CONTEXT"}));`);
	const previousPath = process.env.PATH;
	process.env.PATH = `${fixture.root}${delimiter}${previousPath ?? ""}`;
	context.onTestFinished(() => {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
	});
	const captured: CapturedRequest[] = [];
	const sessions: AgentSession[] = [];
	const originalPrompt = AgentSession.prototype.prompt;
	const promptSpy = vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (this: AgentSession, ...args) {
		if (!sessions.includes(this)) sessions.push(this);
		captureModelRequests(this, captured);
		return originalPrompt.apply(this, args);
	});
	context.onTestFinished(() => { promptSpy.mockRestore(); });
	const files = createRunFileCoordinator(fixture.root);
	const runner = new NornAgentRunner({
		id: "native-adapter-test", runRoot: join(fixture.root, "run"),
		agentDir: fixture.agentDir, model,
		logs: new NornRunLogs(join(fixture.root, "logs"), files),
		logger: new NornRunLogger({ manifestPath: join(fixture.root, "manifest.json"), files, manifest: { id: "native-adapter-test", name: "native-adapter-test", workflowId: "test.worker", runRoot: join(fixture.root, "run"), workspace: fixture.cwd, initialCwd: fixture.cwd, startedAt: new Date().toISOString() } }),
		responseCollector: new NornAgentResponseCollector(),
	});
	const worker = await runner.createSession({ label: "restricted", cwd: fixture.cwd, tools: [], systemPrompt: "SOURCE-ONLY ASSESSOR" });
	context.onTestFinished(() => worker.dispose());
	assert.equal(worker.cwd, fixture.cwd);
	await assert.rejects(readFile(calledPath), { code: "ENOENT" });
	assert.deepEqual(await worker.prompt({ prompt: "Assess only this supplied source.", response: Type.Object({ ok: Type.Boolean() }), maxAttempts: 1 }), { ok: true });
	const decoded = await worker.prompt({ prompt: "Record the next assessment.", response: Type.Decode(Type.Object({ ok: Type.Boolean() }), result => result.ok ? "accepted" : "rejected"), maxAttempts: 1 });
	assert.equal(decoded, "accepted");
	assert.equal(sessions.length, 1);
	const session = sessions[0];
	assert.ok(session.resourceLoader.getExtensions().extensions.some(extension => extension.path.endsWith("pi-norn/dist/index.js")));
	assert.ok(session.getAllTools().some(tool => tool.name === AGENT_RESPONSE_TOOL_NAME));
	session.setActiveToolsByName([]);
	await session.bindExtensions({ uiContext: session.extensionRunner.getUIContext() });
	await session.reload();
	session.setActiveToolsByName([]);
	assert.deepEqual(session.getActiveToolNames(), []);
	assert.ok(session.getAllTools().some(tool => tool.name === AGENT_RESPONSE_TOOL_NAME));
	await session.prompt("Check the same context with the response tool inactive");
	assert.deepEqual(lastRequest(captured).tools, []);
	for (const request of captured) {
		assert.ok(request.systemPrompt.startsWith("SOURCE-ONLY ASSESSOR"));
		assert.ok(!request.systemPrompt.includes("<norn-docs-intro>"));
		assert.ok(!request.systemPrompt.includes("UNWANTED AUTHORING CONTEXT"));
	}
	await assert.rejects(readFile(calledPath), { code: "ENOENT" });
});

test("native custom state tools retain values across sessions and session cleanup covers startup failure", { timeout: 30000 }, async context => {
	const fixture = await createFixture(context);
	const { resources, state } = await initializeSharedState(fixture.root);
	const field = { id: "count", schema: Type.Integer() };
	const hidden = { id: "private", schema: Type.String() };
	await state.set(hidden, "not attached");
	const captured: CapturedRequest[] = [];
	const nativeSessions: AgentSession[] = [];
	const calls = [
		{ name: "norn_state_list", arguments: { offset: 0, limit: 10000 } },
		{ name: "norn_state_get", arguments: { key: "private", offset: 0, limit: 10000 } },
		{ name: "norn_state_set", arguments: { key: "count", value: "invalid" } },
		{ name: "norn_state_set", arguments: { key: "count", value: 7 } },
		{ name: "norn_state_get", arguments: { key: "count", offset: 0, limit: 10000 } },
	];
	const originalPrompt = AgentSession.prototype.prompt;
	const promptSpy = vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (this: AgentSession, ...args) {
		if (!nativeSessions.includes(this)) {
			nativeSessions.push(this);
			captureModelRequests(this, captured, nativeSessions.length === 1 ? calls : []);
		}
		return originalPrompt.apply(this, args);
	});
	context.onTestFinished(() => promptSpy.mockRestore());
	const runner = new NornAgentRunner({
		id: "resource-sdk", runRoot: join(fixture.root, "current"),
		agentDir: fixture.agentDir, model,
		logs: new NornRunLogs(join(fixture.root, "current", "logs"), resources.files),
		logger: new NornRunLogger({ manifestPath: join(fixture.root, "current", "manifest.json"), files: resources.files, manifest: { id: "resource-sdk", name: "resource-sdk", workflowId: "test.worker", runRoot: fixture.root, workspace: fixture.cwd, initialCwd: fixture.cwd, startedAt: new Date().toISOString() } }),
		responseCollector: new NornAgentResponseCollector(),
	});
	const disposalSpy = vi.spyOn(AgentSession.prototype, "dispose");
	context.onTestFinished(() => disposalSpy.mockRestore());
	const customTools = createStateTools({ state, fields: [{ field, access: "read-write" }] });
	const tools = customTools.map(tool => tool.name);
	const worker = await runner.createSession({ label: "writer", cwd: fixture.root, tools, customTools });
	context.onTestFinished(() => worker.dispose());
	assert.equal(worker.cwd, fixture.root);
	assert.deepEqual(await worker.prompt({ prompt: "Exercise attached state", response: Type.Object({ ok: Type.Boolean() }), maxAttempts: 1 }), { ok: true });
	assert.deepEqual(new Set(captured[0].tools), new Set([AGENT_RESPONSE_TOOL_NAME, "norn_state_list", "norn_state_get", "norn_state_set"]));
	assert.equal(await state.get(field), 7);
	const results = nativeSessions[0].messages.filter(message => message.role === "toolResult");
	assert.equal(results.filter(message => message.isError).length, 2);
	await worker.dispose();
	await worker.dispose();
	assert.equal(disposalSpy.mock.calls.length, 1);
	await runner.prompt({ label: "unattached", cwd: fixture.cwd, tools: [], prompt: "Return the result", response: Type.Object({ ok: Type.Boolean() }), maxAttempts: 1 });
	assert.deepEqual(lastRequest(captured).tools, [AGENT_RESPONSE_TOOL_NAME]);
	assert.equal(await (await initializeSharedState(fixture.root)).state.get(field), 7);
	await runner.prompt({ label: "selected-one-shot", cwd: fixture.cwd, tools: ["norn_state_get"], customTools, prompt: "Return the result", response: Type.Object({ ok: Type.Boolean() }), maxAttempts: 1 });
	assert.deepEqual(new Set(lastRequest(captured).tools), new Set([AGENT_RESPONSE_TOOL_NAME, "norn_state_get"]));
	assert.equal(disposalSpy.mock.calls.length, 3);
	await assert.rejects(runner.createSession({ label: "broken-start", cwd: fixture.cwd, customTools, beforeSessionStart() { throw new Error("startup failure"); } }), /startup failure/);
	assert.equal(disposalSpy.mock.calls.length, 4);
	for (const name of [customTools[0].name, "read", AGENT_RESPONSE_TOOL_NAME]) {
		await assert.rejects(runner.createSession({ label: "collision", cwd: fixture.cwd, tools: [], customTools: [customTools[0], { ...customTools[0], name }] }), /Custom tool name collision/);
	}
	assert.equal(disposalSpy.mock.calls.length, 4);
});

test("plain custom tools follow Pi defaults, explicit selection, and loaded-extension collisions", { timeout: 30000 }, async context => {
	const fixture = await createFixture(context);
	const draftPath = join(fixture.cwd, "draft.txt");
	await writeFile(draftPath, "Workflow-owned draft");
	await mkdir(join(fixture.agentDir, "extensions"));
	await writeFile(join(fixture.agentDir, "extensions", "extra.ts"), `export default pi => {
		pi.registerTool({ name: "extra_tool", label: "Extra", description: "Return an extension value.",
			parameters: { type: "object", properties: {} },
			async execute() { return { content: [{ type: "text", text: "extra" }], details: {} }; }
		});
	};`);
	const reads: string[] = [];
	const readDraft: ToolDefinition = {
		name: "read_draft", label: "Read draft", description: "Read the workflow's draft.", parameters: Type.Object({}),
		async execute(_id, _args, signal) {
			const text = await readFile(draftPath, { encoding: "utf8", signal });
			reads.push(text);
			return { content: [{ type: "text", text }], details: { text } };
		},
	};
	const customTools = [readDraft, { ...readDraft, name: "spare_tool" }];
	const captured: CapturedRequest[] = [];
	const nativeSessions: AgentSession[] = [];
	let shouldReadDraft = false;
	const originalPrompt = AgentSession.prototype.prompt;
	const promptSpy = vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (this: AgentSession, ...args) {
		if (!nativeSessions.includes(this)) {
			nativeSessions.push(this);
			captureModelRequests(this, captured, shouldReadDraft ? [{ name: readDraft.name, arguments: {} }] : []);
		}
		return originalPrompt.apply(this, args);
	});
	context.onTestFinished(() => promptSpy.mockRestore());
	const files = createRunFileCoordinator(fixture.root);
	const runner = new NornAgentRunner({
		id: "custom-tools", runRoot: join(fixture.root, "run"), agentDir: fixture.agentDir, model,
		logs: new NornRunLogs(join(fixture.root, "logs"), files),
		logger: new NornRunLogger({ manifestPath: join(fixture.root, "manifest.json"), files, manifest: { id: "custom-tools", name: "custom-tools", workflowId: "test.worker", runRoot: join(fixture.root, "run"), workspace: fixture.cwd, initialCwd: fixture.cwd, startedAt: new Date().toISOString() } }),
		responseCollector: new NornAgentResponseCollector(),
	});
	for (const scenario of [
		{ tools: undefined, expected: ["read", "bash", "edit", "write", "extra_tool", readDraft.name, "spare_tool"] },
		{ tools: [], expected: [] },
		{ tools: [readDraft.name], expected: [readDraft.name] },
		{ tools: ["read", readDraft.name, "extra_tool"], expected: ["read", readDraft.name, "extra_tool"] },
	]) {
		shouldReadDraft = scenario.expected.includes(readDraft.name);
		const readCount = reads.length;
		assert.deepEqual(await runner.prompt({ label: "selection", cwd: fixture.cwd, tools: scenario.tools, customTools, prompt: "Read the draft if available and report success.", response: Type.Object({ ok: Type.Boolean() }), maxAttempts: 1 }), { ok: true });
		assert.deepEqual(new Set(lastRequest(captured).tools), new Set([...scenario.expected, AGENT_RESPONSE_TOOL_NAME]));
		assert.equal(reads.length, readCount + Number(shouldReadDraft));
	}
	assert.ok(reads.every(text => text === "Workflow-owned draft"));
	await writeFile(join(fixture.agentDir, "settings.json"), JSON.stringify({ defaultTools: ["grep"] }));
	shouldReadDraft = false;
	await runner.prompt({ label: "configured-defaults", cwd: fixture.cwd, customTools, prompt: "Return the result.", response: Type.Object({ ok: Type.Boolean() }), maxAttempts: 1 });
	assert.deepEqual(new Set(lastRequest(captured).tools), new Set(["grep", "extra_tool", readDraft.name, "spare_tool", AGENT_RESPONSE_TOOL_NAME]));
	await assert.rejects(runner.createSession({ label: "extension-collision", cwd: fixture.cwd, customTools: [{ ...readDraft, name: "extra_tool" }] }), /Custom tool name collision: extra_tool/);
});

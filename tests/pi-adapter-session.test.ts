import assert from "node:assert/strict";
import { createRunFileCoordinator } from "../src/files.ts";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi, type TestContext } from "vitest";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { AgentSession, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

import { NornAgentRunner } from "../src/internal/agents.ts";
import { NornRunResources, type NornResourceFamily } from "../src/resources.ts";
import { State } from "../src/state.ts";
import { NornRunLogs } from "../src/internal/logs.ts";
import { NornRunLogger } from "../src/internal/run-log.ts";
import type { NornWorkflowCatalogInfo, NornWorkflowInspection } from "../src/api.ts";
import { AGENT_RESPONSE_TOOL_NAME, NornAgentResponseCollector } from "../src/internal/agent-response-tool.ts";
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
	for (const path of ["src", "bin", "docs", "setup", "examples", "adapters", "README.md", "package.json"]) await cp(join(packageRoot, path), join(runtimeRoot, path), { recursive: true });
	await symlink(join(packageRoot, "node_modules"), join(runtimeRoot, "node_modules"));
	const manifest = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8"));
	manifest.version = "9.9.9";
	await writeFile(join(runtimeRoot, "package.json"), JSON.stringify(manifest));
	const shadow = join(fixture.root, "shadow");
	await mkdir(shadow);
	await writeExecutable(join(shadow, "norn"), 'process.stdout.write(JSON.stringify({intro:"PATH runtime introduction"}));');
	const previousPath = process.env.PATH;
	process.env.PATH = `${shadow}${delimiter}${previousPath}`;
	context.onTestFinished(() => { process.env.PATH = previousPath; });

	const directIntro = JSON.parse(execFileSync(join(runtimeRoot, "bin/norn.mjs"), ["docs", "intro"], { cwd: fixture.cwd, encoding: "utf8" }));
	assert.ok(directIntro.intro.includes('Version: "9.9.9"'));
	const settingsManager = SettingsManager.inMemory({ packages: [packageRoot], compaction: { enabled: false }, retry: { enabled: false } });
	let useCustomPrompt = true;
	const loader = new DefaultResourceLoader({
		cwd: fixture.cwd, agentDir: fixture.agentDir, settingsManager,
		systemPromptOverride: base => useCustomPrompt ? "CUSTOM SYSTEM PROMPT" : base,
		agentsFilesOverride: () => ({ agentsFiles: [{ path: join(fixture.cwd, "AGENTS.md"), content: "PROJECT CONTEXT" }] }),
		extensionFactories: [{ name: "other-prompt-extension", factory: pi => { pi.on("before_agent_start", event => ({ systemPrompt: event.systemPrompt + "\nOTHER EXTENSION" })); } }],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	assert.ok(loader.getExtensions().extensions.some(extension => extension.path.endsWith("adapters/pi.ts")));
	const { session } = await createAgentSession({ cwd: fixture.cwd, agentDir: fixture.agentDir, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(fixture.cwd), model, tools: ["read"] });
	context.onTestFinished(() => session.dispose());
	loader.getExtensions().runtime.flagValues.set("norn-executable", join(runtimeRoot, "bin/norn.mjs"));
	const captured: CapturedRequest[] = [];
	captureModelRequests(session, captured);
	await session.bindExtensions({ uiContext: session.extensionRunner.getUIContext() });
	manifest.version = "9.9.10";
	await writeFile(join(runtimeRoot, "package.json"), JSON.stringify(manifest));
	await session.prompt("First ordinary task");
	const first = lastRequest(captured).systemPrompt;
	assert.ok(first.startsWith("CUSTOM SYSTEM PROMPT"));
	assert.ok(first.includes("PROJECT CONTEXT"));
	assert.ok(first.includes("OTHER EXTENSION"));
	assert.ok(first.includes('Version: "9.9.9"'), first);
	assert.ok(first.includes("other installation/docs/README.md"));
	assert.ok(!first.includes("PATH runtime introduction"));
	assert.equal(first.split("<norn-docs-intro>").length - 1, 1);
	assert.ok(first.includes(directIntro.intro));
	const runtimeLine = first.match(/^Runtime argv .*: (.+)$/m);
	assert.ok(runtimeLine);
	const invocation: [string, ...string[]] = JSON.parse(runtimeLine[1]);
	const invoke = <Output>(args: readonly string[]): Output => JSON.parse(execFileSync(invocation[0], [...invocation.slice(1), ...args], { cwd: fixture.cwd, encoding: "utf8", timeout: 30_000 }));
	await writeFile(join(fixture.cwd, "norn.project.json"), JSON.stringify({ version: 1, plugins: [] }));
	assert.deepEqual(invoke<NornWorkflowCatalogInfo>(["workflows", "list"]).workflows, []);
	const plugin = (await readFile(join(packageRoot, "examples/minimal-workflow/plugin.ts"), "utf8")).replace('id: "greeting"', 'id: "fresh"');
	await writeFile(join(fixture.cwd, "plugin.ts"), plugin);
	await writeFile(join(fixture.cwd, "norn.project.json"), JSON.stringify({ version: 1, plugins: ["./plugin.ts"] }));
	assert.deepEqual(invoke<NornWorkflowCatalogInfo>(["workflows", "list"]).workflows.map(workflow => workflow.id), ["fresh.write"]);
	const inspection = invoke<NornWorkflowInspection>(["workflows", "inspect", "fresh.write"]);
	assert.ok(inspection.workflow);
	assert.equal(inspection.workflow.id, "fresh.write");
	assert.deepEqual(inspection.workflow.paramsSchema.required, ["name"]);
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
	await writeFile(join(fixture.agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot], compaction: { enabled: false }, retry: { enabled: false } }));
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
		id: "native-adapter-test", runRoot: join(fixture.root, "run"), boundaryRoot: fixture.cwd, boundaryName: "test", cwd: fixture.cwd,
		agentDir: fixture.agentDir, model,
		logs: new NornRunLogs(join(fixture.root, "logs"), files),
		logger: new NornRunLogger({ manifestPath: join(fixture.root, "manifest.json"), files, manifest: { id: "native-adapter-test", name: "native-adapter-test", workflowId: "test.worker", runRoot: join(fixture.root, "run"), workspace: fixture.cwd, initialCwd: fixture.cwd, startedAt: new Date().toISOString() } }),
		responseCollector: new NornAgentResponseCollector(),
	});
	const worker = await runner.createSession({ label: "restricted", tools: [], systemPrompt: "SOURCE-ONLY ASSESSOR" });
	context.onTestFinished(() => worker.dispose());
	await assert.rejects(readFile(calledPath), { code: "ENOENT" });
	assert.deepEqual(await worker.prompt({ prompt: "Assess only this supplied source.", response: z.object({ ok: z.boolean() }), maxAttempts: 1 }), { ok: true });
	assert.equal(sessions.length, 1);
	const session = sessions[0];
	assert.ok(session.resourceLoader.getExtensions().extensions.some(extension => extension.path.endsWith("adapters/pi.ts")));
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

test("native resource tools are explicit, persist across sessions, and clean up on disposal and startup failure", { timeout: 30000 }, async context => {
	const fixture = await createFixture(context);
	const resources = await NornRunResources.initialize(fixture.root);
	const field = { id: "count", schema: z.number().int() };
	const hidden = { id: "private", schema: z.string() };
	await resources.state.set(hidden, "not attached");
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
		id: "resource-sdk", runRoot: join(fixture.root, "current"), boundaryRoot: fixture.cwd, boundaryName: "test", cwd: fixture.cwd,
		agentDir: fixture.agentDir, model,
		logs: new NornRunLogs(join(fixture.root, "current", "logs"), resources.files),
		logger: new NornRunLogger({ manifestPath: join(fixture.root, "current", "manifest.json"), files: resources.files, manifest: { id: "resource-sdk", name: "resource-sdk", workflowId: "test.worker", runRoot: fixture.root, workspace: fixture.cwd, initialCwd: fixture.cwd, startedAt: new Date().toISOString() } }),
		responseCollector: new NornAgentResponseCollector(),
	});
	let disposals = 0;
	const lifecycle: NornResourceFamily = { name: "test.lifecycle", async bind() { return { tools: [], async dispose() { disposals++; } }; } };
	const attachment = State({ state: resources.state, fields: [{ field, access: "read-write" }] });
	const worker = await runner.createSession({ label: "writer", tools: [], resources: [attachment, lifecycle] });
	context.onTestFinished(() => worker.dispose());
	assert.deepEqual(await worker.prompt({ prompt: "Exercise attached state", response: z.object({ ok: z.boolean() }), maxAttempts: 1 }), { ok: true });
	assert.deepEqual(new Set(captured[0].tools), new Set([AGENT_RESPONSE_TOOL_NAME, "norn_state_list", "norn_state_get", "norn_state_set"]));
	assert.equal(await resources.state.get(field), 7);
	const results = nativeSessions[0].messages.filter(message => message.role === "toolResult");
	assert.equal(results.filter(message => message.isError).length, 2);
	await worker.dispose();
	await worker.dispose();
	assert.equal(disposals, 1);
	await runner.prompt({ label: "unattached", tools: [], prompt: "Return the result", response: z.object({ ok: z.boolean() }), maxAttempts: 1 });
	assert.deepEqual(lastRequest(captured).tools, [AGENT_RESPONSE_TOOL_NAME]);
	assert.equal(await (await NornRunResources.initialize(fixture.root)).state.get(field), 7);
	await runner.prompt({ label: "attached-one-shot", tools: [], resources: [attachment, lifecycle], prompt: "Return the result", response: z.object({ ok: z.boolean() }), maxAttempts: 1 });
	assert.ok(lastRequest(captured).tools.includes("norn_state_get"));
	assert.equal(disposals, 2);
	await assert.rejects(runner.createSession({ label: "broken-start", resources: [lifecycle], beforeSessionStart() { throw new Error("startup failure"); } }), /startup failure/);
	assert.equal(disposals, 3);
	await assert.rejects(runner.createSession({ label: "duplicate", resources: [lifecycle, lifecycle] }), /Duplicate resource family/);
	assert.equal(disposals, 4);
	const collision: NornResourceFamily = { name: "test.collision", async bind() {
		const binding = await attachment.bind({ runId: "test", label: "collision" });
		return { tools: [{ ...binding.tools[0], name: "read" }], async dispose() { disposals++; } };
	} };
	await assert.rejects(runner.createSession({ label: "collision", resources: [lifecycle, collision] }), /tool name collision/);
	assert.equal(disposals, 6);
});

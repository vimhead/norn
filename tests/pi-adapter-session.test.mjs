import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createJiti } from "jiti";
import { AgentSession, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const piJiti = createJiti(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { AssistantMessageEventStream } = await piJiti.import("@earendil-works/pi-ai");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { NornAgentRunner } = await jiti.import("../src/internal/agents.ts");
const { AGENT_RESPONSE_TOOL_NAME, NornAgentResponseCollector } = await jiti.import("../src/internal/agent-response-tool.ts");
const model = { id: "offline", name: "Offline test", provider: "offline-test", api: "anthropic-messages", baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

async function createFixture(context) {
	const root = await mkdtemp(join(tmpdir(), "norn-pi-adapter-"));
	context.after(() => rm(root, { recursive: true, force: true }));
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
	context.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
	});
	return { root, cwd, agentDir };
}

function captureModelRequests(session, captured) {
	session.modelRuntime.hasConfiguredAuth = () => true;
	session.agent.streamFunction = (_model, context) => {
		captured.push({ systemPrompt: context.systemPrompt, tools: context.tools.map(tool => tool.name) });
		const stream = new AssistantMessageEventStream();
		const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: "Offline response" }], stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		if (context.tools.some(tool => tool.name === AGENT_RESPONSE_TOOL_NAME)) {
			const prompt = context.messages.filter(message => message.role === "user").at(-1).content;
			const text = typeof prompt === "string" ? prompt : prompt.filter(part => part.type === "text").map(part => part.text).join("\n");
			message.content = [{ type: "toolCall", id: "offline-response", name: AGENT_RESPONSE_TOOL_NAME, arguments: { runId: text.match(/Pass runId exactly as: (.+)/)[1], label: text.match(/Pass label exactly as: (.+)/)[1], response: { ok: true } } }];
			message.stopReason = "toolUse";
		}
		stream.push({ type: "done", reason: message.stopReason, message });
		stream.end(message);
		return stream;
	};
}

async function writeExecutable(path, source) {
	await writeFile(path, `#!/usr/bin/env node\n${source}\n`);
	await chmod(path, 0o700);
}

test("Pi package loading advertises the skill and appends fresh runtime-selected context across turns and reload", { skip: process.platform === "win32", timeout: 60_000 }, async context => {
	const fixture = await createFixture(context);
	const runtimeRoot = join(fixture.root, "other installation");
	await mkdir(runtimeRoot);
	for (const path of ["src", "bin", "docs", "examples", "skills", "adapters", "README.md", "package.json"]) await cp(join(packageRoot, path), join(runtimeRoot, path), { recursive: true });
	await symlink(join(packageRoot, "node_modules"), join(runtimeRoot, "node_modules"));
	const manifest = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8"));
	manifest.version = "9.9.9";
	await writeFile(join(runtimeRoot, "package.json"), JSON.stringify(manifest));
	const shadow = join(fixture.root, "shadow");
	await mkdir(shadow);
	await writeExecutable(join(shadow, "norn"), 'process.stdout.write(JSON.stringify({intro:"PATH runtime introduction"}));');
	const previousPath = process.env.PATH;
	process.env.PATH = `${shadow}${delimiter}${previousPath}`;
	context.after(() => { process.env.PATH = previousPath; });

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
	assert.ok(loader.getSkills().skills.some(skill => skill.name === "norn" && skill.filePath === join(packageRoot, "skills/norn/SKILL.md")), JSON.stringify(loader.getSkills()));
	const { session } = await createAgentSession({ cwd: fixture.cwd, agentDir: fixture.agentDir, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(fixture.cwd), model, tools: ["read"] });
	context.after(() => session.dispose());
	loader.getExtensions().runtime.flagValues.set("norn-executable", join(runtimeRoot, "bin/norn.mjs"));
	const captured = [];
	captureModelRequests(session, captured);
	await session.bindExtensions({});
	await session.prompt("First ordinary task");
	const first = captured.at(-1).systemPrompt;
	assert.ok(first.startsWith("CUSTOM SYSTEM PROMPT"));
	assert.ok(first.includes("PROJECT CONTEXT"));
	assert.ok(first.includes("OTHER EXTENSION"));
	assert.ok(first.includes("<available_skills>"));
	assert.ok(first.includes(join(packageRoot, "skills/norn/SKILL.md")));
	assert.ok(first.includes('Version: "9.9.9"'), first);
	assert.ok(first.includes("other installation/docs/README.md"));
	assert.ok(!first.includes("PATH runtime introduction"));
	assert.equal(first.split("<norn-docs-intro>").length - 1, 1);
	assert.ok(first.includes(directIntro.intro));
	const invocation = JSON.parse(first.match(/^Runtime argv .*: (.+)$/m)[1]);
	const invoke = args => JSON.parse(execFileSync(invocation[0], [...invocation.slice(1), ...args], { cwd: fixture.cwd, encoding: "utf8", timeout: 30_000 }));
	await writeFile(join(fixture.cwd, "norn.project.json"), JSON.stringify({ version: 1, plugins: [] }));
	assert.deepEqual(invoke(["workflows", "list"]).workflows, []);
	const plugin = (await readFile(join(packageRoot, "examples/minimal-workflow/plugin.ts"), "utf8")).replace('id: "greeting"', 'id: "fresh"');
	await writeFile(join(fixture.cwd, "plugin.ts"), plugin);
	await writeFile(join(fixture.cwd, "norn.project.json"), JSON.stringify({ version: 1, plugins: ["./plugin.ts"] }));
	assert.deepEqual(invoke(["workflows", "list"]).workflows.map(workflow => workflow.id), ["fresh.write"]);
	const inspection = invoke(["workflows", "inspect", "fresh.write"]);
	assert.equal(inspection.workflow.id, "fresh.write");
	assert.ok(inspection.workflow.paramsSchema.required.includes("name"));
	assert.ok(!first.includes("fresh.write"));

	manifest.version = "9.9.10";
	await writeFile(join(runtimeRoot, "package.json"), JSON.stringify(manifest));
	await session.prompt("Next ordinary task");
	assert.ok(captured.at(-1).systemPrompt.includes('Version: "9.9.10"'));
	assert.ok(!captured.at(-1).systemPrompt.includes('Version: "9.9.9"'));
	await session.reload();
	await session.prompt("Task after reload");
	assert.equal(captured.at(-1).systemPrompt.split("<norn-docs-intro>").length - 1, 1);
	assert.ok(captured.at(-1).systemPrompt.includes('Version: "9.9.10"'));

	useCustomPrompt = false;
	await session.reload();
	await session.prompt("Task with Pi's default prompt");
	assert.ok(captured.at(-1).systemPrompt.startsWith("You are an expert coding assistant"));
	assert.ok(captured.at(-1).systemPrompt.includes("Pi documentation"));
	assert.ok(captured.at(-1).systemPrompt.includes("<available_skills>"));
	assert.equal(captured.at(-1).systemPrompt.split("<norn-docs-intro>").length - 1, 1);
	loader.getExtensions().runtime.flagValues.delete("norn-executable");
	await session.prompt("Use the PATH runtime now");
	assert.ok(captured.at(-1).systemPrompt.includes("PATH runtime introduction"));
	assert.ok(!captured.at(-1).systemPrompt.includes('Version: "9.9.10"'));
	loader.getExtensions().runtime.flagValues.set("norn-executable", join(fixture.root, "missing-executable"));
	await session.prompt("Task with an unavailable runtime");
	assert.ok(captured.at(-1).systemPrompt.includes("PROJECT CONTEXT"));
	assert.ok(!captured.at(-1).systemPrompt.includes("<norn-docs-intro>"));
	assert.ok(!captured.at(-1).systemPrompt.includes("PATH runtime introduction"));
});

test("a real native Norn worker excludes the adapter, including after reload with its response tool inactive", { skip: process.platform === "win32", timeout: 30_000 }, async context => {
	const fixture = await createFixture(context);
	await writeFile(join(fixture.agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot], compaction: { enabled: false }, retry: { enabled: false } }));
	const calledPath = join(fixture.root, "cli-called");
	const executable = join(fixture.root, "norn-probe");
	await writeExecutable(executable, `require("node:fs").writeFileSync(${JSON.stringify(calledPath)}, "called"); process.stdout.write(JSON.stringify({intro:"UNWANTED AUTHORING CONTEXT"}));`);
	const captured = [];
	const sessions = [];
	const originalPrompt = AgentSession.prototype.prompt;
	context.mock.method(AgentSession.prototype, "prompt", async function (...args) {
		if (!sessions.includes(this)) sessions.push(this);
		this.resourceLoader.getExtensions().runtime.flagValues.set("norn-executable", executable);
		captureModelRequests(this, captured);
		return originalPrompt.apply(this, args);
	});
	const runner = new NornAgentRunner({
		id: "native-adapter-test", runRoot: join(fixture.root, "run"), boundaryRoot: fixture.cwd, boundaryName: "test", cwd: fixture.cwd,
		agentDir: fixture.agentDir, model,
		logs: { write: async () => ({ id: "test-log" }) }, logger: { record: async () => {} }, responseCollector: new NornAgentResponseCollector(),
	});
	const worker = await runner.createSession({ label: "restricted", tools: [], systemPrompt: "SOURCE-ONLY ASSESSOR" });
	context.after(() => worker.dispose());
	assert.deepEqual(await worker.prompt({ prompt: "Assess only this supplied source.", response: z.object({ ok: z.boolean() }), maxAttempts: 1 }), { ok: true });
	assert.equal(sessions.length, 1);
	const session = sessions[0];
	assert.ok(session.resourceLoader.getExtensions().extensions.some(extension => extension.path.endsWith("adapters/pi.ts")));
	assert.ok(session.getAllTools().some(tool => tool.name === AGENT_RESPONSE_TOOL_NAME));
	await session.reload();
	session.setActiveToolsByName([]);
	assert.deepEqual(session.getActiveToolNames(), []);
	assert.ok(session.getAllTools().some(tool => tool.name === AGENT_RESPONSE_TOOL_NAME));
	await session.prompt("Check the same context with the response tool inactive");
	assert.deepEqual(captured.at(-1).tools, []);
	for (const request of captured) {
		assert.ok(request.systemPrompt.startsWith("SOURCE-ONLY ASSESSOR"));
		assert.ok(!request.systemPrompt.includes("<norn-docs-intro>"));
		assert.ok(!request.systemPrompt.includes("UNWANTED AUTHORING CONTEXT"));
	}
	await assert.rejects(readFile(calledPath), { code: "ENOENT" });
});

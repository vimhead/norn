import { AgentSession } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { test, vi, type TestContext } from "vitest";
import { NornAgentResponseCollector } from "../packages/cli/src/internal/agent-response-tool.ts";
import { NornAgentRunner } from "../packages/cli/src/internal/agents.ts";
import { createRunFileCoordinator } from "../packages/cli/src/internal/file-coordinator.ts";
import { NornRunLogs } from "../packages/cli/src/internal/logs.ts";
import { NornRunLogger } from "../packages/cli/src/internal/run-log.ts";

async function createFixture(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "norn-agent-models-"));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	vi.stubEnv("HOME", root);
	vi.stubEnv("PI_OFFLINE", "1");
	context.onTestFinished(() => {
		vi.unstubAllEnvs();
	});
	await writeFile(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: Object.fromEntries(
				["preferred", "fallback", "unconfigured"].map((provider) => [
					provider,
					{
						baseUrl: "https://unused.invalid",
						api: "openai-completions",
						...(provider === "unconfigured"
							? {}
							: { apiKey: "offline-test-key" }),
						models: [{ id: "fixture" }],
					},
				]),
			),
		}),
	);
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "preferred",
			defaultModel: "fixture",
			retry: { enabled: false },
			compaction: { enabled: false },
		}),
	);
	const sessions: AgentSession[] = [];
	const bindExtensions = AgentSession.prototype.bindExtensions;
	const bindingSpy = vi
		.spyOn(AgentSession.prototype, "bindExtensions")
		.mockImplementation(async function (this: AgentSession, ...args) {
			sessions.push(this);
			return bindExtensions.apply(this, args);
		});
	context.onTestFinished(() => bindingSpy.mockRestore());
	const files = createRunFileCoordinator(root);
	const manifestPath = join(root, "manifest.json");
	const runner = new NornAgentRunner({
		id: "models",
		runRoot: root,
		agentDir,
		logs: new NornRunLogs(join(root, "logs"), files),
		logger: new NornRunLogger({
			manifestPath,
			files,
			manifest: {
				id: "models",
				name: "models",
				workflowId: "test.models",
				runRoot: root,
				workspace: root,
				initialCwd: root,
				startedAt: new Date().toISOString(),
			},
		}),
		responseCollector: new NornAgentResponseCollector(),
	});
	return { root, agentDir, manifestPath, runner, sessions };
}

test("models select the first configured candidate in caller order and record it", async (context) => {
	const fixture = await createFixture(context);
	for (const providers of [
		["fallback", "preferred"],
		["preferred", "fallback"],
	] as const) {
		const worker = await fixture.runner.createSession({
			label: providers[0],
			cwd: fixture.root,
			models: [
				{ provider: providers[0], id: "fixture" },
				{ provider: providers[1], id: "fixture" },
			],
			tools: [],
		});
		try {
			assert.equal(fixture.sessions.at(-1)?.model?.provider, providers[0]);
			assert.equal(fixture.sessions.at(-1)?.model?.id, "fixture");
		} finally {
			await worker.dispose();
		}
	}
	const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
	assert.deepEqual(
		manifest.events
			.filter((event: { type: string }) => event.type === "agent.spawned")
			.map((event: { model: unknown }) => event.model),
		[
			{ provider: "fallback", id: "fixture" },
			{ provider: "preferred", id: "fixture" },
		],
	);
});

test("missing registrations and credentials are skipped, including a single configured model", async (context) => {
	const fixture = await createFixture(context);
	for (const models of [
		[{ provider: "fallback", id: "fixture" }],
		[
			{ provider: "missing-provider", id: "fixture" },
			{ provider: "preferred", id: "missing-model" },
			{ provider: "unconfigured", id: "fixture" },
			{ provider: "fallback", id: "fixture" },
		],
	] as const) {
		const worker = await fixture.runner.createSession({
			label: "fallback",
			cwd: fixture.root,
			models,
			tools: [],
		});
		try {
			assert.equal(fixture.sessions.at(-1)?.model?.provider, "fallback");
		} finally {
			await worker.dispose();
		}
	}
});

test("unusable models report every reason without selecting a configured default", async (context) => {
	const fixture = await createFixture(context);
	await assert.rejects(
		fixture.runner.createSession({
			label: "unavailable",
			cwd: fixture.root,
			models: [
				{ provider: "missing-provider", id: "fixture" },
				{ provider: "preferred", id: "missing-model" },
				{ provider: "unconfigured", id: "fixture" },
			],
		}),
		{
			message:
				"No usable agent models:\nmissing-provider/fixture: not registered\npreferred/missing-model: not registered\nunconfigured/fixture: no configured credentials",
		},
	);
	assert.equal(fixture.sessions.length, 0);
});

test("models require a non-empty list of complete provider/id references", async (context) => {
	const fixture = await createFixture(context);
	for (const models of [undefined, null, [], {}, "preferred/fixture"]) {
		await assert.rejects(
			Reflect.apply(fixture.runner.createSession, fixture.runner, [
				{
					label: "invalid",
					cwd: fixture.root,
					models,
				},
			]),
			/Agent models must be a non-empty ordered list/,
		);
	}
	for (const reference of [
		null,
		{},
		{ provider: "preferred" },
		{ provider: "", id: "fixture" },
		{ provider: "preferred", id: " " },
		{ provider: 1, id: "fixture" },
	]) {
		await assert.rejects(
			Reflect.apply(fixture.runner.createSession, fixture.runner, [
				{
					label: "invalid",
					cwd: fixture.root,
					models: [{ provider: "preferred", id: "fixture" }, reference],
				},
			]),
			/Agent models\[1\] requires non-empty provider and id strings/,
		);
	}
	assert.equal(fixture.sessions.length, 0);
});

test("models resolve installed extension providers before prompting", async (context) => {
	const fixture = await createFixture(context);
	await writeFile(
		join(fixture.agentDir, "settings.json"),
		JSON.stringify({
			packages: [
				fileURLToPath(new URL("./fixtures/pi-provider", import.meta.url)),
			],
			retry: { enabled: false },
			compaction: { enabled: false },
		}),
	);
	await writeFile(
		join(fixture.agentDir, "auth.json"),
		JSON.stringify({
			"norn-offline": { type: "api_key", key: "offline-test-key" },
		}),
	);
	const result = await fixture.runner.prompt({
		label: "extension",
		cwd: fixture.root,
		models: [
			{ provider: "norn-offline", id: "fixture" },
			{ provider: "fallback", id: "fixture" },
		],
		tools: [],
		prompt: "Return ok",
		response: Type.Object({ ok: Type.Boolean() }),
		maxAttempts: 1,
	});
	assert.deepEqual(result, { ok: true });
	assert.equal(fixture.sessions[0]?.model?.provider, "norn-offline");
});

test("inference failures do not select another model or repeat the prompt", async (context) => {
	const fixture = await createFixture(context);
	const promptSpy = vi
		.spyOn(AgentSession.prototype, "prompt")
		.mockRejectedValue(new Error("Provider rejected the request"));
	context.onTestFinished(() => promptSpy.mockRestore());
	await assert.rejects(
		fixture.runner.prompt({
			label: "failed",
			cwd: fixture.root,
			models: [
				{ provider: "preferred", id: "fixture" },
				{ provider: "fallback", id: "fixture" },
			],
			tools: [],
			prompt: "Return ok",
			response: Type.Object({ ok: Type.Boolean() }),
			maxAttempts: 3,
		}),
		/Provider rejected the request/,
	);
	assert.equal(fixture.sessions.length, 1);
	assert.equal(fixture.sessions[0]?.model?.provider, "preferred");
	assert.equal(promptSpy.mock.calls.length, 1);
});

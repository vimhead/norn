import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test, vi, type TestContext } from "vitest";
import { z } from "zod";
import { NornAgentRunner } from "../src/internal/agents.ts";
import { NornAgentResponseCollector } from "../src/internal/agent-response-tool.ts";
import { NornRunLogs } from "../src/internal/logs.ts";
import { NornRunLogger } from "../src/internal/run-log.ts";
import { createRunFileCoordinator } from "../src/files.ts";

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = join(packageRoot, "bin/norn.mjs");

async function createFixture(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "norn-pi-cli-"));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_PACKAGE_DIR: "/unrelated-pi", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" };
	const invoke = (args: string[], stdin = "") => {
		const execution = execute(process.execPath, [cli, ...args], { cwd: root, env, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
		execution.child.stdin?.end(stdin);
		return execution;
	};
	return { root, agentDir, invoke };
}

test("Pi arguments, help, version and failures bypass Norn's CLI envelope without a project", { timeout: 30_000 }, async context => {
	const fixture = await createFixture(context);
	const piManifest = JSON.parse(await readFile(join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
	assert.equal((await fixture.invoke(["pi", "--version"])).stdout.trim(), piManifest.version);
	assert.match((await fixture.invoke(["pi", "--help"])).stdout, /pi - AI coding assistant/);
	assert.match((await fixture.invoke(["help", "pi"])).stdout, /norn pi \[pi arguments/);
	assert.equal(JSON.parse((await fixture.invoke(["commands", "inspect", "pi"])).stdout).command.id, "pi");
	await assert.rejects(fixture.invoke(["pi", "install"]), error => {
		assert.equal((error as { code: number }).code, 1);
		assert.equal((error as { stdout: string }).stdout, "");
		assert.match((error as { stderr: string }).stderr, /Missing install source/);
		return true;
	});
});

test("a provider installed through norn pi is selectable in Pi and native Norn workers using the same credentials", { timeout: 60_000 }, async context => {
	const fixture = await createFixture(context);
	const providerPath = join(fixture.root, "provider with spaces");
	await cp(join(packageRoot, "tests/fixtures/pi-provider"), providerPath, { recursive: true });
	await fixture.invoke(["pi", "install", providerPath]);
	const settingsPath = join(fixture.agentDir, "settings.json");
	const settings = JSON.parse(await readFile(settingsPath, "utf8"));
	assert.equal(await realpath(join(fixture.agentDir, settings.packages[0])), await realpath(providerPath));
	await writeFile(settingsPath, JSON.stringify({ ...settings, defaultProvider: "norn-offline", defaultModel: "fixture", retry: { enabled: false }, compaction: { enabled: false } }));
	await writeFile(join(fixture.agentDir, "auth.json"), JSON.stringify({ "norn-offline": { type: "api_key", key: "offline-test-key" } }), { mode: 0o600 });
	assert.match((await fixture.invoke(["pi", "--list-models", "norn-offline"])).stdout, /fixture/);
	const prompt = 'literal --help && echo "not a shell"';
	const response = JSON.parse((await fixture.invoke(["pi", "--no-session", "-p", prompt])).stdout);
	assert.equal(response.prompt, prompt);
	assert.equal(await realpath(response.cwd), await realpath(fixture.root));
	assert.ok((await readFile(join(response.docs, "custom-provider.md"), "utf8")).includes("pi.registerProvider"));
	const piped = JSON.parse((await fixture.invoke(["pi", "--no-session", "-p"], prompt)).stdout);
	assert.equal(piped.prompt, prompt);
	const events = (await fixture.invoke(["pi", "--no-session", "--mode", "json", "-p", prompt])).stdout.trim().split("\n").map(line => JSON.parse(line));
	assert.ok(events.some(event => event.type === "message_end" && event.message.role === "assistant"));

	vi.stubEnv("PI_OFFLINE", "1");
	context.onTestFinished(() => { vi.unstubAllEnvs(); });
	const files = createRunFileCoordinator(fixture.root);
	const runner = new NornAgentRunner({
		id: "provider-worker", runRoot: fixture.root, boundaryRoot: fixture.root, boundaryName: "test", cwd: fixture.root,
		agentDir: fixture.agentDir,
		logs: new NornRunLogs(join(fixture.root, "logs"), files),
		logger: new NornRunLogger({ manifestPath: join(fixture.root, "manifest.json"), files, manifest: { id: "provider-worker", name: "provider-worker", workflowId: "test.worker", runRoot: fixture.root, workspace: fixture.root, initialCwd: fixture.root, startedAt: new Date().toISOString() } }),
		responseCollector: new NornAgentResponseCollector(),
	});
	assert.deepEqual(await runner.prompt({ label: "worker", tools: [], prompt: "Return ok", response: z.object({ ok: z.boolean() }), maxAttempts: 1 }), { ok: true });
	await fixture.invoke(["pi", "remove", providerPath]);
	assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")).packages, []);
});

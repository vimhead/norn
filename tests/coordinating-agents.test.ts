import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { test, vi, type TestContext } from "vitest";
import { manifest } from "../examples/coordinating-multiple-agents/plugin.ts";
import { workQueueDefinition } from "../examples/coordinating-multiple-agents/work-queue.ts";
import { NornAgentRunner } from "../packages/cli/src/internal/agents.ts";
import { AGENT_RESPONSE_TOOL_NAME } from "@vimhead.dev/norn-core/agent-protocol";
import { NornEngine } from "../packages/cli/src/internal/engine.ts";
import { getRunInfo } from "../packages/cli/src/internal/run-state.ts";
import { NornRunResources } from "../packages/cli/src/resources.ts";
import { loadNornProject } from "../packages/cli/src/plugin-loader.ts";

const model: Model<"anthropic-messages"> = { id: "offline", name: "Offline queue agent", provider: "offline-test", api: "anthropic-messages", baseUrl: "https://unused.invalid", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const notes = Array.from({ length: 4 }, (_, index) => ({ id: `note-${index}`, text: `The team recorded source note ${index} for the release review.` }));

async function createWorkflowFixture(context: TestContext, input: { failureLabel: string | undefined; shouldInventQuote: boolean; isReportOnly?: boolean }) {
	const root = await mkdtemp(join(tmpdir(), "norn-coordinating-agents-"));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const home = join(root, "home");
	await mkdir(agentDir);
	await mkdir(home);
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
	vi.stubEnv("HOME", home);
	context.onTestFinished(() => { vi.unstubAllEnvs(); });
	let failureLabel = input.failureLabel;
	const sessions = new Set<AgentSession>();
	const claims: { label: string; id: string; token: string }[] = [];
	const activeTools: string[][] = [];
	let activePrompts = 0;
	let maximumConcurrentPrompts = 0;
	let releaseFirstRound!: () => void;
	const firstRoundClaims = new Promise<void>(resolve => { releaseFirstRound = resolve; });
	const originalCreate = NornAgentRunner.prototype.createSession;
	const createSpy = vi.spyOn(NornAgentRunner.prototype, "createSession").mockImplementation(function (this: NornAgentRunner, options) {
		return originalCreate.call(this, { ...options, model });
	});
	const originalPrompt = AgentSession.prototype.prompt;
	const promptSpy = vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (this: AgentSession, ...args) {
		if (!sessions.has(this)) {
			sessions.add(this);
			this.modelRuntime.hasConfiguredAuth = () => true;
			let phase = 0;
			this.agent.streamFunction = async (_model, request) => {
				activeTools.push((request.tools ?? []).map(tool => tool.name));
				const user = request.messages.filter(message => message.role === "user").at(-1);
				assert.ok(user);
				const prompt = typeof user.content === "string" ? user.content : user.content.filter(part => part.type === "text").map(part => part.text).join("\n");
				const runId = prompt.match(/Pass runId exactly as: (.+)/)?.[1];
				const label = prompt.match(/Pass label exactly as: (.+)/)?.[1];
				assert.ok(runId && label);
				if (label === failureLabel) throw new Error("Simulated model outage");
				let call: { name: string; arguments: Record<string, unknown> };
				if (input.isReportOnly) {
					call = { name: AGENT_RESPONSE_TOOL_NAME, arguments: { runId, label, response: { status: "acknowledged", detail: "An unsupported success claim." } } };
				} else if (phase === 0) {
					call = { name: "queue_claim", arguments: {} };
				} else if (phase === 1) {
					const response = request.messages.filter(message => message.role === "toolResult" && message.toolName === "queue_claim").at(-1);
					assert.ok(response && response.role === "toolResult" && !response.isError);
					const text = response.content.find(part => part.type === "text");
					assert.ok(text && text.type === "text");
					const { claim } = JSON.parse(text.text) as { claim: { id: string; token: string; text: string } | null };
					if (claim === null) {
						call = { name: AGENT_RESPONSE_TOOL_NAME, arguments: { runId, label, response: { status: "idle", detail: "No note available." } } };
					} else {
						claims.push({ label, id: claim.id, token: claim.token });
						if (label.startsWith("round-0-")) {
							if (claims.filter(claim => claim.label.startsWith("round-0-")).length === 2) releaseFirstRound();
							await firstRoundClaims;
						}
						call = { name: "queue_acknowledge", arguments: { id: claim.id, token: claim.token, result: { summary: `Summary of ${claim.id}.`, quote: input.shouldInventQuote ? "A quotation absent from every source." : claim.text } } };
					}
				} else {
					const response = request.messages.filter(message => message.role === "toolResult" && message.toolName === "queue_acknowledge").at(-1);
					assert.ok(response && response.role === "toolResult" && !response.isError);
					call = { name: AGENT_RESPONSE_TOOL_NAME, arguments: { runId, label, response: { status: "acknowledged", detail: "Result saved through the queue tool." } } };
				}
				phase++;
				const message: AssistantMessage = {
					role: "assistant", api: model.api, provider: model.provider, model: model.id,
					content: [{ type: "toolCall", id: `offline-${phase}`, ...call }], stopReason: "toolUse", timestamp: Date.now(),
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				const stream = new AssistantMessageEventStream();
				stream.push({ type: "done", reason: "toolUse", message });
				stream.end(message);
				return stream;
			};
		}
		activePrompts++;
		maximumConcurrentPrompts = Math.max(maximumConcurrentPrompts, activePrompts);
		try { return await originalPrompt.apply(this, args); }
		finally { activePrompts--; }
	});
	context.onTestFinished(() => { createSpy.mockRestore(); promptSpy.mockRestore(); });
	await cp(new URL("../examples/coordinating-multiple-agents/", import.meta.url), root, { recursive: true });
	const engine = new NornEngine({ cwd: root, agentDir });
	for (const plugin of (await loadNornProject(root)).plugins) engine.registerPlugin(plugin);
	return { root, agentDir, engine, sessions, claims, activeTools, maximumConcurrentPrompts: () => maximumConcurrentPrompts, repairModel: () => { failureLabel = undefined; } };
}

for (const noteCount of [3, 4]) {
	test(`the copied example coordinates Norn agent sessions and verifies ${noteCount} persisted results`, { timeout: 30000 }, async context => {
		const setup = await createWorkflowFixture(context, { failureLabel: undefined, shouldInventQuote: false });
		const selectedNotes = notes.slice(0, noteCount);
		const result = await setup.engine.runWorkflow(manifest.workflows.start, { notes: selectedNotes }, undefined);
		assert.equal(result.status, "completed");
		assert.deepEqual(result.metadata?.data, { processed: noteCount });
		const runRoot = join(setup.root, ".norn/runs", result.id);
		const saved = JSON.parse(await readFile(join(runRoot, "current/artifacts/summaries.json"), "utf8"));
		assert.deepEqual(saved.map((item: { id: string }) => item.id), selectedNotes.map(note => note.id));
		assert.ok(saved.every((item: { source: string; quote: string; deliveries: number }) => item.source.includes(item.quote) && item.deliveries === 1));
		assert.equal(setup.maximumConcurrentPrompts(), 2);
		assert.equal(setup.sessions.size, 4);
		assert.equal(new Set(setup.claims.map(claim => claim.id)).size, noteCount);
		for (const tools of setup.activeTools) assert.deepEqual(new Set(tools), new Set([AGENT_RESPONSE_TOOL_NAME, "queue_status", "queue_claim", "queue_acknowledge"]));
		assert.ok([...setup.sessions].every(session => !session.isStreaming));
	});
}

test("agent success reports without persisted results cannot complete the example", async context => {
	const setup = await createWorkflowFixture(context, { failureLabel: undefined, shouldInventQuote: false, isReportOnly: true });
	const result = await setup.engine.runWorkflow(manifest.workflows.start, { notes }, undefined);
	assert.equal(result.status, "failed");
	const queue = await (await NornRunResources.initialize(join(setup.root, ".norn/runs", result.id))).ensure(workQueueDefinition);
	assert.equal((await queue.inspect()).acknowledged, 0);
});

test("acknowledgment is not semantic approval: the example rejects invented quotations", { timeout: 30000 }, async context => {
	const setup = await createWorkflowFixture(context, { failureLabel: undefined, shouldInventQuote: true });
	await assert.rejects(setup.engine.runWorkflow(manifest.workflows.start, { notes }, { id: "invalid-quotes" }), /Unverified result or source quotation/);
	const runRoot = join(setup.root, ".norn/runs/invalid-quotes");
	assert.equal((await getRunInfo(runRoot)).status, "failed");
	const queue = await (await NornRunResources.initialize(runRoot)).ensure(workQueueDefinition);
	assert.equal((await queue.inspect()).acknowledged, 4);
	await assert.rejects(readFile(join(runRoot, "current/artifacts/summaries.json")), { code: "ENOENT" });
});

test("native rollback and fresh Norn agents retain checkpointed results and retry only the interrupted round", { timeout: 30000 }, async context => {
	const setup = await createWorkflowFixture(context, { failureLabel: "round-1-worker-2", shouldInventQuote: false });
	await assert.rejects(setup.engine.runWorkflow(manifest.workflows.start, { notes }, { id: "recover-queue" }), /Queue agents failed/);
	const runRoot = join(setup.root, ".norn/runs/recover-queue");
	assert.equal((await getRunInfo(runRoot)).status, "failed");
	await cp(join(runRoot, "current"), join(setup.root, "preserved-failed-attempt"), { recursive: true });
	const checkpoints = await setup.engine.listRunCheckpoints(runRoot);
	const checkpoint = checkpoints.at(-1);
	assert.ok(checkpoint);
	await setup.engine.rollbackRun(runRoot, checkpoint.id);
	const queue = await (await NornRunResources.initialize(runRoot)).ensure(workQueueDefinition);
	const restored = await queue.inspect();
	assert.equal(restored.acknowledged, 2);
	assert.equal(restored.available, 2);
	assert.equal(restored.leased, 0);
	const completedIds = restored.items.filter(item => item.status === "acknowledged").map(item => item.id);
	const priorClaims = setup.claims.length;
	setup.repairModel();
	const resumed = new NornEngine({ cwd: setup.root, agentDir: setup.agentDir });
	for (const plugin of (await loadNornProject(setup.root)).plugins) resumed.registerPlugin(plugin);
	const result = await resumed.resumeWorkflow(runRoot);
	assert.equal(result.status, "completed");
	assert.equal((await queue.inspect()).acknowledged, 4);
	assert.ok(setup.claims.slice(priorClaims).every(claim => !completedIds.includes(claim.id)));
	assert.ok([...setup.sessions].every(session => !session.isStreaming));
});

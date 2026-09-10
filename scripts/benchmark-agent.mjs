import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { benchmarkCases } from "./benchmark-cases.mjs";

const executeFile = promisify(execFile);
const { values } = parseArgs({ options: {
	help: { type: "boolean" },
	"norn-root": { type: "string" }, "pi-root": { type: "string" },
	baseline: { type: "string" }, output: { type: "string" },
	provider: { type: "string" }, model: { type: "string" },
	"max-turns": { type: "string" }, "timeout-ms": { type: "string" },
} });
if (values.help) {
	console.log([
		"Run paired live-agent smoke trials with an existing authenticated Pi provider (Node >=22.19).",
		"Required flags: --norn-root PATH --pi-root PATH --baseline SKILLS_DIR --output JSON_PATH",
		"                --provider NAME --model ID --max-turns NUMBER --timeout-ms NUMBER",
		"Baseline is a skills directory, not a package root. Rewritten skills come from this checkout.",
		"Trials use temporary projects. Results and transcripts stay outside the package.",
		"The small suite checks Norn adoption, targeted recovery, and avoiding unnecessary automation; it is not a statistical quality benchmark.",
	].join("\n"));
	process.exit(0);
}
for (const name of ["norn-root", "pi-root", "baseline", "output", "provider", "model", "max-turns", "timeout-ms"]) {
	assert.ok(values[name], `Required option: --${name}`);
}
const nornRoot = resolve(values["norn-root"]);
const outputPath = resolve(values.output);
const maxTurns = Number(values["max-turns"]);
const timeoutMs = Number(values["timeout-ms"]);
assert.ok(Number.isInteger(maxTurns) && maxTurns > 0);
assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0);
const workspace = await mkdtemp(join(tmpdir(), "norn-agent-benchmark-"));
const sourceCli = join(nornRoot, "bin/norn.mjs");
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(join(resolve(values["pi-root"]), "dist/index.js")));
const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel(values.provider, values.model);
assert.ok(model, "Requested benchmark model is not available");
assert.ok(modelRuntime.hasConfiguredAuth(values.provider), "Benchmark provider authentication is not configured");
const variants = [
	{ name: "baseline", path: resolve(values.baseline) },
	{ name: "rewritten", path: fileURLToPath(new URL("../skills", import.meta.url)) },
];
const report = {
	kind: "paired-agent-task-smoke-benchmark",
	limitations: "One trial per case and variant; no statistical performance claim. Runtime scenarios and skill size are separate measurements. No nested model calls are permitted.",
	model: `${values.provider}/${values.model}`, thinkingLevel: "low", nodeVersion: process.version, maxTurns, timeoutMs,
	costBasis: "Pi model-catalog estimate; actual billing depends on the provider and account",
	nornRevision: (await executeFile("git", ["-C", nornRoot, "rev-parse", "HEAD"])).stdout.trim(),
	workspace, variants: [], trials: [],
};
for (const variant of variants) {
	const snapshot = join(workspace, "skill-snapshots", variant.name);
	await cp(variant.path, snapshot, { recursive: true });
	variant.path = snapshot;
	report.variants.push({ name: variant.name, ...await measureSkills(snapshot) });
}
await mkdir(dirname(outputPath), { recursive: true });
await saveReport();
for (const [caseIndex, benchmarkCase] of benchmarkCases.entries()) {
	const orderedVariants = caseIndex % 2 ? [...variants].reverse() : variants;
	for (const variant of orderedVariants) {
		const trial = await runTrial({ benchmarkCase, variant });
		report.trials.push(trial);
		await saveReport();
		console.log(`${trial.variant} / ${trial.case}: ${trial.passed ? "PASS" : "FAIL"}; ${trial.turns} turns, ${trial.toolCalls} tool calls, ${Math.round(trial.wallMs / 1000)}s`);
	}
}
console.log(`Results: ${outputPath}`);
if (report.trials.some(trial => !trial.passed)) process.exitCode = 1;

async function runTrial({ benchmarkCase, variant }) {
	const trialRoot = join(workspace, `${benchmarkCase.id}-${variant.name}`);
	const cwd = join(trialRoot, "project");
	const agentDir = join(trialRoot, "agent");
	const bin = join(trialRoot, "bin");
	await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true }), mkdir(bin, { recursive: true })]);
	await cp(variant.path, join(agentDir, "trial-skills"), { recursive: true });
	await writeFile(join(cwd, "norn.project.json"), JSON.stringify({ version: 1, includes: [] }));
	await writeFile(join(bin, "norn"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(sourceCli)} "$@"\n`, { mode: 0o755 });
	const cli = (args, input) => executeCli({ cwd, args, input });
	const fixture = await benchmarkCase.prepare({ cwd, cli });
	const settingsManager = SettingsManager.inMemory({
		packages: [], compaction: { enabled: false }, retry: { enabled: false },
		shellCommandPrefix: `export PATH=${shellQuote(bin)}:${shellQuote(dirname(process.execPath))}:$PATH`,
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalSkillPaths: [join(agentDir, "trial-skills")],
		systemPromptOverride: () => [
			"You are an autonomous coding agent completing the user's task in a temporary synthetic project.",
			"Norn is installed and available as norn on PATH. Use the supplied skills when their activation conditions match.",
			`When needed, Norn's installed README is ${join(nornRoot, "README.md")}; its API is ${join(nornRoot, "src/api.ts")}. Other runtime source under that checkout may be read, not modified.`,
			"Write only inside the current project. Do not install packages, run git operations, access credentials, use the network, or invoke nested model sessions or other agent processes. Deterministic workflows and Norn CLI executors are allowed.",
			"Complete the requested work rather than describing a plan. Choose the smallest actions that satisfy it. Do not ask for confirmation unless required intent or scope is missing. Report only verified outcomes.",
		].join("\n"),
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const { session } = await createAgentSession({
		cwd, agentDir, resourceLoader, settingsManager, modelRuntime, model,
		thinkingLevel: "low", sessionManager: SessionManager.inMemory(cwd),
		tools: ["read", "bash", "edit", "write"],
	});
	const trial = { case: benchmarkCase.id, variant: variant.name, cwd, turns: 0, toolCalls: 0, skillReads: [], toolNames: [], initialPromptBytes: Buffer.byteLength(session.systemPrompt), wallMs: 0, error: null, checks: {}, passed: false };
	const unsubscribe = session.subscribe(event => {
		if (event.type === "turn_end") {
			trial.turns++;
			if (trial.turns >= maxTurns && event.message.content.some(content => content.type === "toolCall")) {
				trial.error = "Agent turn budget reached";
				void session.abort();
			}
		}
		if (event.type === "tool_execution_start") {
			trial.toolCalls++;
			trial.toolNames.push(event.toolName);
			if (event.toolName === "read" && /SKILL\.md$/.test(event.args?.path ?? "")) trial.skillReads.push(event.args.path);
		}
	});
	const started = performance.now();
	const timeout = setTimeout(() => { trial.error = "Agent time budget reached"; void session.abort(); }, timeoutMs);
	try {
		await session.prompt(benchmarkCase.prompt(fixture));
	} catch (error) {
		trial.error = error instanceof Error ? error.message : String(error);
	} finally {
		clearTimeout(timeout);
		unsubscribe();
		trial.wallMs = Math.round(performance.now() - started);
	}
	const messages = session.messages;
	const assistantMessages = messages.filter(message => message.role === "assistant");
	const last = assistantMessages.at(-1);
	trial.finalText = last?.content.filter(content => content.type === "text").map(content => content.text).join("\n") ?? "";
	trial.usage = sumUsage(assistantMessages);
	if (last?.stopReason === "error" || last?.stopReason === "aborted") trial.error ??= last.errorMessage ?? last.stopReason;
	session.dispose();
	try {
		trial.checks = await benchmarkCase.evaluate({ cwd, cli, fixture, finalText: trial.finalText });
	} catch (error) {
		trial.evaluationError = error instanceof Error ? error.message : String(error);
		trial.checks = { evaluationSucceeded: false };
	}
	trial.passed = trial.error === null && Object.values(trial.checks).every(Boolean);
	const transcript = messages.map(message => ({ ...message, ...(Array.isArray(message.content) ? { content: message.content.filter(content => content.type !== "thinking") } : {}) }));
	await writeFile(join(trialRoot, "transcript.json"), JSON.stringify(transcript, null, 2));
	return trial;
}

async function executeCli({ cwd, args, input }) {
	const result = await new Promise((resolveExecution, reject) => {
		const child = execFile(process.execPath, [sourceCli, ...args], { cwd, timeout: 20000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new Error(`${args.join(" ")}: ${stdout || stderr || error.message}`));
			else resolveExecution(stdout);
		});
		child.stdin.end(input === undefined ? "" : JSON.stringify(input));
	});
	return JSON.parse(result);
}

async function measureSkills(root) {
	const skills = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const text = await readFile(join(root, entry.name, "SKILL.md"), "utf8");
		skills.push({ name: entry.name, bytes: Buffer.byteLength(text), lines: text.trimEnd().split("\n").length, sha256: createHash("sha256").update(text).digest("hex") });
	}
	return { skills, totalBytes: skills.reduce((total, skill) => total + skill.bytes, 0) };
}

function sumUsage(messages) {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const message of messages) {
		for (const field of ["input", "output", "cacheRead", "cacheWrite"]) total[field] += message.usage?.[field] ?? 0;
		total.cost += message.usage?.cost?.total ?? 0;
	}
	return total;
}

function shellQuote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function saveReport() {
	await writeFile(outputPath, JSON.stringify(report, null, 2));
}

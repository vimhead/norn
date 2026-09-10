import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { changeMetadataFeed, evaluateMetadataStage, metadataPrompts, prepareMetadataProject, preparePartnerImporter } from "./task-trajectory-fixtures.mjs";
import { changeSupportProject, evaluateSupportStage, prepareSupportProject, supportPrompts } from "./support-trajectory-fixtures.mjs";
import { evaluateQueueStage, openQueueSink, prepareQueueProject, queuePrompts } from "./queue-trajectory-fixtures.mjs";
import { evaluateSupportQueue, prepareSupportQueue, supportQueuePrompts } from "./support-queue-transfer.mjs";

const executeFile = promisify(execFile);
const { values } = parseArgs({ options: {
	help: { type: "boolean" }, variants: { type: "string" },
	root: { type: "string" }, "norn-root": { type: "string" }, "pi-root": { type: "string" },
	provider: { type: "string" }, model: { type: "string" },
	variant: { type: "string" }, family: { type: "string" }, "seed-root": { type: "string" }, "preflight-only": { type: "boolean" },
} });
if (values.help) {
	console.log([
		"Evaluate task trajectories with fresh outer sessions and real model workers (Node >=22.19).",
		"Required: --root FRESH_DIRECTORY --norn-root CHECKOUT --pi-root PACKAGE --provider NAME --model ID",
		"Optional: --family metadata|support|queue|support-queue|trivial --variant NAME or --variants no,current,baseline,revised",
		"ROOT must contain each selected NAME-skills directory; no-skills is empty. Directories are snapshotted.",
		"Queue additionally requires --seed-root PROJECT with a verified extract.mjs and policy.txt.",
		"--preflight-only checks isolated, authenticated Norn workers before evaluations.",
		"Uses provider quota and may incur charges. Worker credentials remain outside projects and results.",
		"Results separate automatic outcomes from trajectories requiring a semantic/mechanism audit; no aggregate quality score is inferred.",
	].join("\n"));
	process.exit(0);
}
for (const key of ["root", "norn-root", "pi-root", "provider", "model"]) assert.ok(values[key], `Missing --${key}`);
const root = resolve(values.root);
const nornRoot = resolve(values["norn-root"]);
const piRoot = resolve(values["pi-root"]);
const sdk = await import(pathToFileURL(join(piRoot, "dist/index.js")));
const modelRuntime = await sdk.ModelRuntime.create();
const model = modelRuntime.getModel(values.provider, values.model);
assert.ok(model && modelRuntime.hasConfiguredAuth(values.provider), "Requested model/provider must be configured");
const family = values.family ?? "metadata";
assert.ok(["metadata", "support", "queue", "support-queue", "trivial"].includes(family));
if (family === "queue") assert.ok(values["seed-root"], "Queue trials need an existing verified extractor via --seed-root");
const trajectories = {
	metadata: { prepare: prepareMetadataProject, prompts: metadataPrompts, advance: async ({ cwd, stage }) => { if (stage === 1) await changeMetadataFeed({ cwd }); if (stage === 2) await preparePartnerImporter({ cwd }); }, evaluate: evaluateMetadataStage },
	support: { prepare: prepareSupportProject, prompts: supportPrompts, advance: changeSupportProject, evaluate: evaluateSupportStage },
	queue: { prepare: ({ cwd }) => prepareQueueProject({ cwd, seedRoot: resolve(values["seed-root"]) }), prompts: queuePrompts, advance: openQueueSink, evaluate: evaluateQueueStage },
	"support-queue": { prepare: prepareSupportQueue, prompts: supportQueuePrompts, advance: openQueueSink, evaluate: evaluateSupportQueue },
	trivial: {
		prepare: async () => {},
		prompts: ['Normalize [" red", "BLUE", "red "] by trimming, lowercasing, deduplicating and sorting. Return only the JSON array.'],
		evaluate: async ({ cwd, finalText }) => {
			let normalizedLabels;
			try { normalizedLabels = JSON.parse(finalText); } catch { normalizedLabels = null; }
			return { exactAnswer: JSON.stringify(normalizedLabels) === '["blue","red"]', noProjectFiles: (await readdir(cwd)).length === 0 };
		},
	},
};
const trajectory = trajectories[family];
const originalAgentDirectory = sdk.getAgentDir();
const runtimeRevision = (await executeFile("git", ["-C", nornRoot, "rev-parse", "HEAD"])).stdout.trim();
assert.ok(!(values.variant && values.variants), "Choose --variant or --variants, not both");
const variants = values.variants ? values.variants.split(",") : values.variant ? [values.variant] : ["no", "current", "baseline"];
assert.equal(new Set(variants).size, variants.length, "Do not repeat an arm in the same root");
assert.ok(variants.every(variant => ["no", "current", "baseline", "revised"].includes(variant)));
const reportPath = join(root, values["preflight-only"] ? "preflight.json" : `trajectory-${values.variant ?? "all"}.json`);
const report = { family, runtimeRevision, costBasis: "Pi model-catalog estimate; not an invoice", model: `${values.provider}/${values.model}`, thinking: "low", limits: { turnsPerStage: 32, millisecondsPerStage: 360000, workerSessionsPerTrajectory: 12 }, trials: [] };
await mkdir(root, { recursive: true });
const guide = (await readFile(join(nornRoot, "README.md"), "utf8")).split("## Setting up a Norn project")[1].split("## Development")[0];
await writeFile(join(root, "runtime-guide.md"), "# Norn runtime\n\n## Setting up a Norn project" + guide);
if (values["preflight-only"]) {
	const environment = await prepareEnvironment({ variant: "preflight" });
	await writeFile(join(environment.cwd, "norn.project.json"), JSON.stringify({ version: 1, plugins: ["./preflight.ts"] }));
	await writeFile(join(environment.cwd, "preflight.ts"), `import { definePluginManifest, definePlugin } from 'norn'; import { z } from 'zod';
const manifest=definePluginManifest({id:'preflight',workflows:{check:{instructions:'Verify a live worker responds.',isEntrypoint:true,params:z.object({})}}});
export default definePlugin(manifest,{workflows:{check:{async execute(run){const response=await run.agents.prompt({label:'connection-check',tools:[],prompt:'Return ok=true using the response tool.',response:z.object({ok:z.literal(true)}),maxAttempts:1});return run.complete({data:response});}}}});`);
	const launched = await runCli({ environment, args: ["runs", "start", "preflight.check"], input: { params: {} } });
	const settled = await runCli({ environment, args: ["runs", "wait", launched.run.id], input: undefined });
	assert.equal(settled.run.status, "completed");
	assert.equal(settled.run.outcome.metadata.data.ok, true);
	await writeFile(reportPath, JSON.stringify({ passed: true, environment: environment.cwd, workers: await collectWorkers(environment) }, null, 2));
	console.log("PASS live Norn worker preflight, isolated resources and configured provider");
} else {
	for (const variant of variants) {
		const environment = await prepareEnvironment({ variant });
		await trajectory.prepare({ cwd: environment.cwd });
		const skillDirectory = join(root, `${variant}-skills`);
		const assignedSkills = await snapshotSkills({ source: skillDirectory, destination: join(environment.trialRoot, "assigned-skills") });
		if (variant === "no") assert.equal(assignedSkills.hashes.length, 0, "The no-skill arm must have no skill bodies");
		for (let stage = 0; stage < trajectory.prompts.length; stage++) {
			if (stage > 0) await trajectory.advance({ cwd: environment.cwd, stage });
			const trial = await executeStage({ variant, stage, environment, assignedSkills });
			report.trials.push(trial);
			await writeFile(reportPath, JSON.stringify(report, null, 2));
			console.log(`${variant} stage ${stage + 1}: ${JSON.stringify(trial.checks)}; ${trial.turns} turns; ${trial.workers.length} retained worker sessions; ${Math.round(trial.wallMs / 1000)}s${trial.error ? `; ${trial.error}` : ""}`);
		}
	}
	console.log(`Trajectory results: ${reportPath}`);
}

async function prepareEnvironment({ variant }) {
	const trialRoot = join(root, `trajectory-${variant}`);
	await mkdir(trialRoot);
	const cwd = join(trialRoot, "project");
	const workerAgentDirectory = join(trialRoot, "worker-runtime");
	const workerHome = join(trialRoot, "worker-home");
	const bin = join(trialRoot, "bin");
	for (const directory of [cwd, workerAgentDirectory, workerHome, bin]) await mkdir(directory, { recursive: true });
	for (const name of ["auth.json", "models.json", "models-store.json"]) {
		try { await symlink(join(originalAgentDirectory, name), join(workerAgentDirectory, name)); }
		catch (error) { if (error.code !== "EEXIST") throw error; }
	}
	await writeFile(join(workerAgentDirectory, "settings.json"), JSON.stringify({ defaultProvider: values.provider, defaultModel: values.model, defaultThinkingLevel: "low", packages: [], skills: [], extensions: [], compaction: { enabled: false }, retry: { enabled: false } }));
	const environmentVariables = { HOME: workerHome, PI_CODING_AGENT_DIR: workerAgentDirectory, PI_OFFLINE: "1", PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}` };
	await writeFile(join(bin, "norn"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(nornRoot, "bin/norn.mjs"))} "$@"\n`, { mode: 0o755 });
	const workerWrapper = join(bin, "worker-cli.mjs");
	await writeFile(workerWrapper, `import { spawn } from 'node:child_process';
const supplied = process.argv.slice(2).filter(argument => argument !== '--no-session');
const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(join(piRoot, "dist/cli.js"))}, '--provider', ${JSON.stringify(values.provider)}, '--model', ${JSON.stringify(values.model)}, '--thinking', 'low', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--session-dir', ${JSON.stringify(join(workerAgentDirectory, "cli-sessions"))}, ...supplied], { stdio: 'inherit' });
child.on('exit', code => { process.exitCode = code ?? 1; });
`);
	await writeFile(join(bin, "pi"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(workerWrapper)} "$@"\n`, { mode: 0o755 });
	return { cwd, trialRoot, workerAgentDirectory, environmentVariables };
}

async function snapshotSkills({ source, destination }) {
	await cp(source, destination, { recursive: true });
	const files = await listFiles(destination);
	return { destination, hashes: await Promise.all(files.filter(path => path.endsWith("SKILL.md")).map(async path => ({ path, sha256: createHash("sha256").update(await readFile(path)).digest("hex") }))) };
}

async function executeStage({ variant, stage, environment, assignedSkills }) {
	const { cwd, trialRoot } = environment;
	const outerAgentDirectory = join(trialRoot, `outer-${stage}`);
	await mkdir(outerAgentDirectory, { recursive: true });
	const prefix = Object.entries(environment.environmentVariables).map(([key, value]) => `export ${key}=${quote(value)}`).join("; ");
	const settingsManager = sdk.SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false }, shellCommandPrefix: prefix });
	const resourceLoader = new sdk.DefaultResourceLoader({
		cwd, agentDir: outerAgentDirectory, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalSkillPaths: [assignedSkills.destination],
		systemPromptOverride: () => [
			"You are a coding agent completing the user's task in the current temporary project. Execute and verify the requested work; do not merely propose a plan.",
			`Available CLIs: node, python3, git, pi, norn. Pi and Norn workers have authenticated ${values.provider}/${values.model} defaults. For independent model calls, use pi or Norn workers, not direct provider APIs. At most 12 worker sessions are available for this project across the work; use source-bounded prompts, not entire conversations.`,
			`Runtime docs: ${join(root, "runtime-guide.md")}; Norn API/source: ${join(nornRoot, "src")}. Pi CLI supports --help, --print and --tools.`,
			"Use only the advertised skills; do not read other skill files from runtime checkouts or global directories. Do not install packages or change the real runtime. Write only inside the current project. No external-system mutations or publication, no credential inspection, and no network except configured model calls. Do not modify tools/publish.mjs. Local fixture execution and editing are authorized.",
			"Each request may be handled by a new outer session. Existing project files and execution state are available; inspect them instead of assuming a previous conversation.",
		].join("\n"),
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const { session } = await sdk.createAgentSession({ cwd, agentDir: outerAgentDirectory, settingsManager, resourceLoader, modelRuntime, model, thinkingLevel: "low", sessionManager: sdk.SessionManager.inMemory(cwd), tools: ["read", "bash", "edit", "write"] });
	const beforeFiles = await fingerprintProject(cwd);
	const trial = { variant, stage, cwd, skillHashes: assignedSkills.hashes, turns: 0, calls: [], error: null, checks: {}, workers: [], beforeFiles };
	const unsubscribe = session.subscribe(event => {
		if (event.type === "turn_end") {
			trial.turns++;
			if (trial.turns >= 32 && event.message.content.some(content => content.type === "toolCall")) { trial.error = "Outer turn budget reached"; void session.abort(); }
		}
		if (event.type === "tool_execution_start") trial.calls.push({ tool: event.toolName, args: event.args });
	});
	const started = performance.now();
	const timeout = setTimeout(() => { trial.error = "Outer stage time budget reached"; void session.abort(); }, 360000);
	let isBudgetCheckActive = false;
	const budgetMonitor = setInterval(async () => {
		if (isBudgetCheckActive) return;
		isBudgetCheckActive = true;
		try {
			const files = [...await listFiles(join(cwd, ".norn")), ...await listFiles(join(environment.workerAgentDirectory, "cli-sessions"))];
			if (files.filter(path => path.endsWith(".jsonl") && path.split("/").some(part => ["sessions", "cli-sessions"].includes(part))).length > 12) {
				trial.error = "Worker session budget exceeded";
				await session.abort();
			}
		} catch (error) {
			trial.error = `Worker-budget observation failed: ${error.message}`;
			await session.abort();
		} finally { isBudgetCheckActive = false; }
	}, 3000);
	try { await session.prompt(trajectory.prompts[stage]); }
	catch (error) { trial.error = error.message; }
	finally { clearTimeout(timeout); clearInterval(budgetMonitor); unsubscribe(); }
	if (trial.error) {
		try {
			const { runs } = await runCli({ environment, args: ["runs", "list"], input: undefined });
			for (const run of runs.filter(run => run.status === "running")) await runCli({ environment, args: ["runs", "stop", run.id], input: undefined });
		} catch (error) { trial.cleanupError = error.message; }
	}
	trial.wallMs = Math.round(performance.now() - started);
	const messages = session.messages.map(sanitizeMessage);
	const assistantMessages = messages.filter(message => message.role === "assistant");
	const last = assistantMessages.at(-1);
	trial.finalText = last?.content.filter(content => content.type === "text").map(content => content.text).join("\n") ?? "";
	if (["error", "aborted"].includes(last?.stopReason)) trial.error ??= last.errorMessage ?? last.stopReason;
	trial.usage = sumUsage(assistantMessages);
	session.dispose();
	await writeFile(join(trialRoot, `stage-${stage}-transcript.json`), JSON.stringify(messages, null, 2));
	trial.checks = await trajectory.evaluate({ cwd, stage, finalText: trial.finalText, environmentVariables: environment.environmentVariables });
	trial.afterFiles = await fingerprintProject(cwd);
	trial.checks.deliveryToolUnchanged = Object.keys(beforeFiles).filter(path => path.startsWith("tools/")).every(path => beforeFiles[path] === trial.afterFiles[path]);
	trial.checks.sourceInputsUnchanged = Object.keys(beforeFiles).filter(path => path.startsWith("feeds/") || path.startsWith("incoming/") || path === "policy.txt").every(path => beforeFiles[path] === trial.afterFiles[path]);
	trial.workers = await collectWorkers(environment);
	trial.checks.withinWorkerSessionBudget = trial.workers.length <= 12;
	try { trial.runs = (await runCli({ environment, args: ["runs", "list"], input: undefined })).runs; }
	catch (error) { trial.runs = []; trial.runInspectionError = error.message; }
	await cp(cwd, join(trialRoot, `stage-${stage}-files`), { recursive: true, filter: path => !path.split("/").some(part => part === ".norn" || part === ".git") });
	return trial;
}

async function collectWorkers({ cwd, workerAgentDirectory }) {
	const files = [...await listFiles(cwd), ...await listFiles(join(workerAgentDirectory, "cli-sessions"))];
	const workers = [];
	for (const path of files.filter(path => path.endsWith(".jsonl"))) {
		const entries = (await readFile(path, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
		const header = entries.find(entry => entry.type === "session");
		if (!header) continue;
		const messages = entries.filter(entry => entry.type === "message").map(entry => sanitizeMessage(entry.message));
		workers.push({ id: header.id, path, messages, usage: sumUsage(messages.filter(message => message.role === "assistant")) });
	}
	return workers;
}

function sanitizeMessage(message) {
	return { ...message, ...(Array.isArray(message.content) ? { content: message.content.filter(content => content.type !== "thinking") } : {}) };
}

function sumUsage(messages) {
	return messages.reduce((total, message) => ({ input: total.input + (message.usage?.input ?? 0), output: total.output + (message.usage?.output ?? 0), cacheRead: total.cacheRead + (message.usage?.cacheRead ?? 0), estimatedCost: total.estimatedCost + (message.usage?.cost?.total ?? 0) }), { input: 0, output: 0, cacheRead: 0, estimatedCost: 0 });
}

async function fingerprintProject(cwd) {
	const files = (await listFiles(cwd)).filter(path => !path.split("/").some(part => [".norn", ".git"].includes(part)));
	return Object.fromEntries(await Promise.all(files.map(async path => [path.slice(cwd.length + 1), createHash("sha256").update(await readFile(path)).digest("hex")])));
}

async function listFiles(directory) {
	let entries;
	try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
	const files = [];
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...await listFiles(path)); else files.push(path);
	}
	return files;
}

async function runCli({ environment, args, input }) {
	return new Promise((resolveExecution, reject) => {
		const child = execFile(process.execPath, [join(nornRoot, "bin/norn.mjs"), ...args], { cwd: environment.cwd, env: { ...process.env, ...environment.environmentVariables }, timeout: 180000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new Error(stdout || stderr || error.message));
			else { try { resolveExecution(JSON.parse(stdout)); } catch (parseError) { reject(parseError); } }
		});
		child.stdin.end(input === undefined ? "" : JSON.stringify(input));
	});
}

function quote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

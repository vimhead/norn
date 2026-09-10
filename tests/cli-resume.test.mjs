import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cliPath = fileURLToPath(new URL("../bin/norn.mjs", import.meta.url));

async function cli(cwd, args, input) {
	const child = spawn(process.execPath, [cliPath, ...args], { cwd, stdio: "pipe" });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", chunk => stdout += chunk);
	child.stderr.on("data", chunk => stderr += chunk);
	child.stdin.end(input === undefined ? "" : JSON.stringify(input));
	const exitCode = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
	assert.equal(exitCode, 0, `${args.join(" ")}: ${stderr || stdout}`);
	return JSON.parse(stdout);
}

test("detached CLI resumes wait for the new execution, including slow plugin loading", { timeout: 45000 }, async context => {
	const cwd = await mkdtemp(join(tmpdir(), "norn-cli-resume-test-"));
	context.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "norn.project.json"), '{"version":1,"plugins":["./plugin.ts"]}');
	await writeFile(join(cwd, "plugin.ts"), `
import { definePlugin, definePluginManifest } from "norn";
import { z } from "zod";
if (process.argv.includes("execute-run")) await new Promise(resolve => setTimeout(resolve, 1800));
const manifest = definePluginManifest({ id: "cli", workflows: {
	decide: { instructions: "Use to supply the test decision.", isEntrypoint: true, params: z.object({ answer: z.boolean() }), gate: { enabled: true, fields: ["answer"] } }
} });
export default definePlugin(manifest, { workflows: { decide: {
	gate: { describe: () => "Choose" }, execute: (run, params) => run.complete({ data: params })
} } });
`);
	const started = await cli(cwd, ["runs", "start", "cli.decide"], { params: { answer: false } });
	const runId = started.run.id;
	assert.equal((await cli(cwd, ["runs", "wait", runId])).run.status, "interrupted");
	const { checkpoints } = await cli(cwd, ["runs", "checkpoints", runId]);
	const resumed = await cli(cwd, ["runs", "resume", runId], { params: { answer: true } });
	assert.equal(resumed.run.status, "running");
	assert.equal((await cli(cwd, ["runs", "wait", runId])).run.status, "completed");
	assert.equal((await cli(cwd, ["runs", "rollback", runId, checkpoints[0].id])).run.status, "pendingResume");
	assert.equal((await cli(cwd, ["runs", "resume", runId])).run.status, "running");
	assert.equal((await cli(cwd, ["runs", "wait", runId])).run.status, "interrupted");
});

import type { NornRunCheckpoint, NornRunInfo } from "@vimhead.dev/norn";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const cliPath = fileURLToPath(new URL("../packages/cli/bin/norn.mjs", import.meta.url));

async function cli<Output>({ cwd, args, input }: { cwd: string; args: readonly string[]; input?: unknown }): Promise<Output> {
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
	context.onTestFinished(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "norn.project.json"), '{"version":1,"workflows":["./plugin.ts"]}');
	await writeFile(join(cwd, "plugin.ts"), `
import { workflow, workflowScope } from "@vimhead.dev/norn";
import { Type, type TSchema, type Static, type StaticEncode, type StaticDecode } from "typebox";
import { Value } from "typebox/value";
if (process.argv.includes("execute-run")) await new Promise(resolve => setTimeout(resolve, 1800));
const manifestScope = workflowScope({ name: "cli" });
const manifest_decide = manifestScope.workflow({
name: "decide",
entrypoint: { instructions: "Use to supply the test decision." },
args: Type.Object({ answer: Type.Boolean() }),
gate: { enabled: true, fields: ["answer"] , describe: () => "Choose" },
execute: ({ args: args, run: run }) => run.complete({ data: args })
});
export default [manifest_decide];
`);
	const executeRun = (args: readonly string[], input?: unknown) => cli<{ run: NornRunInfo }>({ cwd, args, input });
	const started = await executeRun(["runs", "start", "cli.decide"], { args: { answer: false } });
	const runId = started.run.id;
	assert.equal((await executeRun(["runs", "wait", runId])).run.status, "interrupted");
	const { checkpoints } = await cli<{ checkpoints: NornRunCheckpoint[] }>({ cwd, args: ["runs", "checkpoints", runId] });
	const resumed = await executeRun(["runs", "resume", runId], { args: { answer: true } });
	assert.equal(resumed.run.status, "running");
	assert.equal((await executeRun(["runs", "wait", runId])).run.status, "completed");
	assert.equal((await executeRun(["runs", "rollback", runId, checkpoints[0].id])).run.status, "pendingResume");
	assert.equal((await executeRun(["runs", "resume", runId])).run.status, "running");
	assert.equal((await executeRun(["runs", "wait", runId])).run.status, "interrupted");
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, vi, type TestContext } from "vitest";
import { createRunFileCoordinator } from "../packages/cli/src/internal/file-coordinator.ts";
import { NornCommandRunner } from "../packages/cli/src/internal/commands.ts";
import { NornRunLogs } from "../packages/cli/src/internal/logs.ts";
import { NornRunLogger } from "../packages/cli/src/internal/run-log.ts";
import { isNodeError } from "@vimhead.dev/norn-core/errors";

async function createFixture(context: TestContext, signal?: AbortSignal) {
	const cwd = await mkdtemp(join(tmpdir(), "norn-command-test-"));
	context.onTestFinished(() => rm(cwd, { recursive: true, force: true }));
	const files = createRunFileCoordinator(cwd);
	const logs = new NornRunLogs(join(cwd, "logs"), files);
	const events: Parameters<NornRunLogger["record"]>[0][] = [];
	const logger = new NornRunLogger({ manifestPath: join(cwd, "manifest.json"), files, manifest: { id: "commands", name: "commands", workflowId: "test.commands", runRoot: cwd, workspace: cwd, initialCwd: cwd, startedAt: new Date().toISOString() } });
	vi.spyOn(logger, "record").mockImplementation(async event => { events.push(event); });
	const runner = new NornCommandRunner({ signal, logs, logger });
	return { cwd, logs, logger, events, runner };
}

function printCommand(text: string) {
	return [process.execPath, "-e", `process.stdout.write(${JSON.stringify(text)}); process.stderr.write(${JSON.stringify(`error:${text}`)})`] as const;
}

test("repeated labels retain each invocation's stdout and stderr", async context => {
	const fixture = await createFixture(context);
	const first = await fixture.runner.run({ label: "repeat", cwd: fixture.cwd, command: printCommand("first") });
	const second = await fixture.runner.run({ label: "repeat", cwd: fixture.cwd, command: printCommand("second") });
	assert.notEqual(first.stdoutLog.id, second.stdoutLog.id);
	assert.notEqual(first.stderrLog.id, second.stderrLog.id);
	assert.equal(await fixture.logs.read(first.stdoutLog), "first");
	assert.equal(await fixture.logs.read(first.stderrLog), "error:first");
	assert.equal(await fixture.logs.read(second.stdoutLog), "second");
	assert.equal(await fixture.logs.read(second.stderrLog), "error:second");
	const started = fixture.events.filter(event => event.type === "command.started");
	assert.equal(new Set(started.map(event => event.invocationId)).size, 2);
	assert.equal(started[0].stdoutLogId, first.stdoutLog.id);
});

test("concurrent commands and new runner instances cannot collide on labels", async context => {
	const fixture = await createFixture(context);
	const inputs = Array.from({ length: 8 }, (_, index) => ({ label: index % 2 ? "a/b" : "a_b", cwd: fixture.cwd, command: printCommand(String(index)) }));
	const results = await Promise.all(inputs.map(input => fixture.runner.run(input)));
	const nextRunner = new NornCommandRunner({ logs: fixture.logs, logger: fixture.logger });
	results.push(await nextRunner.run({ label: "a_b", cwd: fixture.cwd, command: printCommand("8") }));
	assert.equal(new Set(results.flatMap(result => [result.stdoutLog.id, result.stderrLog.id])).size, 18);
	for (const [index, result] of results.entries()) assert.equal(await fixture.logs.read(result.stdoutLog), String(index));
});

for (const cancellation of ["timeout", "abort"]) {
	test(`${cancellation} escalates when a child ignores SIGTERM`, { timeout: 15000, skip: process.platform === "win32" }, async context => {
		const controller = new AbortController();
		const fixture = await createFixture(context, controller.signal);
		const pidPath = join(fixture.cwd, "child.pid");
		let pid: number | undefined;
		context.onTestFinished(() => {
			if (pid === undefined) return;
			try { process.kill(pid, "SIGKILL"); } catch (error) { if (!isNodeError(error) || error.code !== "ESRCH") throw error; }
		});
		const script = `process.on("SIGTERM", () => process.stdout.write("ignored\\n")); require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);`;
		const startedAt = Date.now();
		const resultPromise = fixture.runner.run({ label: "stubborn", cwd: fixture.cwd, command: [process.execPath, "-e", script, pidPath], timeoutMs: cancellation === "timeout" ? 800 : 2000 });
		for (let attempt = 0; attempt < 100; attempt++) {
			try { pid = Number(await readFile(pidPath, "utf8")); break; }
			catch (error) { if (!isNodeError(error) || error.code !== "ENOENT") throw error; }
			await delay(20);
		}
		assert.ok(pid !== undefined && pid > 0, "child registered its signal handler");
		if (cancellation === "abort") controller.abort();
		const result = await resultPromise;
		assert.equal(result.killed, true);
		assert.equal(result.exitCode, null);
		assert.match(result.stdoutTail, /ignored/);
		assert.ok(Date.now() - startedAt >= 5000);
		assert.ok(Date.now() - startedAt < 9000, "a second cancellation must not postpone escalation");
		pid = undefined;
	});
}

test("ordinary command failures remain results, not workflow exceptions", async context => {
	const fixture = await createFixture(context);
	const result = await fixture.runner.run({ label: "nonzero", cwd: fixture.cwd, command: [process.execPath, "-e", "process.exit(7)"] });
	assert.equal(result.exitCode, 7);
	assert.equal(result.killed, false);
});

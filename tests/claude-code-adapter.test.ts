import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const hookScript = join(packageRoot, "hooks/norn-session-start.mjs");

async function createFixture(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "norn-claude-adapter-"));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "user workspace");
	await mkdir(cwd);
	return { root, cwd };
}

async function writeExecutable(path: string, source: string) {
	await writeFile(path, `#!/usr/bin/env node\n${source}\n`);
	await chmod(path, 0o700);
}

function runHook(input: {
	cwd: string;
	payload: unknown;
	env?: NodeJS.ProcessEnv;
	command?: string;
}) {
	return new Promise<{ stdout: string; stderr: string; code: number | null }>(
		(resolve, reject) => {
			const child = spawn(
				input.command ?? process.execPath,
				input.command ? [] : [hookScript],
				{
					cwd: input.cwd,
					env: { ...process.env, ...input.env },
					shell: input.command !== undefined,
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8").on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr.setEncoding("utf8").on("data", (chunk) => {
				stderr += chunk;
			});
			child.on("error", reject);
			child.on("close", (code) => resolve({ stdout, stderr, code }));
			child.stdin.end(JSON.stringify(input.payload));
		},
	);
}

function session(cwd: string, overrides: Record<string, unknown> = {}) {
	return {
		hook_event_name: "SessionStart",
		source: "startup",
		cwd,
		...overrides,
	};
}

const expectedContext =
	"<norn-docs-intro>\nSelected runtime docs\n</norn-docs-intro>\n\nSelected project workflows";

for (const source of ["startup", "clear", "compact"]) {
	test(`Claude Code ${source} delivers selected runtime context from the session directory`, async (context) => {
		const fixture = await createFixture(context);
		const calledFrom = join(fixture.root, "called-from");
		await writeExecutable(
			join(fixture.root, "norn"),
			`
require("node:assert/strict").equal(process.argv[3], "intro");
require("node:fs").writeFileSync(${JSON.stringify(calledFrom)}, process.cwd());
process.stdout.write(JSON.stringify({ intro: process.argv[2] === "docs" ? "Selected runtime docs" : "Selected project workflows" }));
`,
		);
		const result = await runHook({
			cwd: packageRoot,
			payload: session(fixture.cwd, { source }),
			env: {
				PATH: `${fixture.root}${delimiter}${process.env.PATH ?? ""}`,
				NORN_EXECUTABLE: "",
				CLAUDE_PROJECT_DIR: packageRoot,
			},
		});
		assert.equal(result.code, 0);
		assert.equal(result.stderr, "");
		assert.deepEqual(JSON.parse(result.stdout), {
			hookSpecificOutput: {
				hookEventName: "SessionStart",
				additionalContext: expectedContext,
			},
		});
		assert.equal(
			await realpath(await readFile(calledFrom, "utf8")),
			await realpath(fixture.cwd),
		);
	});
}

for (const overrides of [
	{ source: "resume" },
	{ source: "fork" },
	{ agent_type: "restricted-reviewer" },
	{ agent_id: "delegate" },
]) {
	test(`Claude Code skips duplicate or delegated context: ${JSON.stringify(overrides)}`, async (context) => {
		const fixture = await createFixture(context);
		const result = await runHook({
			cwd: fixture.cwd,
			payload: session(fixture.cwd, overrides),
			env: { NORN_EXECUTABLE: join(fixture.root, "missing-runtime") },
		});
		assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
	});
}

const failures = [
	[
		"nonzero exit",
		'process.stderr.write("secret diagnostic"); process.exit(1);',
	],
	["invalid JSON", 'process.stdout.write("secret diagnostic");'],
	["missing intro", 'process.stdout.write("{}");'],
	["wrong intro type", "process.stdout.write(JSON.stringify({ intro: 42 }));"],
	[
		"oversized response",
		'process.stdout.write(JSON.stringify({ intro: "a".repeat(16_385) }));',
	],
] as const;

for (const group of ["docs", "workflows"]) {
	for (const [label, source] of failures) {
		test(`Claude Code reports ${group} ${label} without leaking diagnostics or partial context`, async (context) => {
			const fixture = await createFixture(context);
			const executable = join(fixture.root, "norn");
			await writeExecutable(
				executable,
				`if (process.argv[2] === ${JSON.stringify(group)}) { ${source} } else { process.stdout.write(JSON.stringify({ intro: "Valid intro" })); }`,
			);
			const result = await runHook({
				cwd: fixture.cwd,
				payload: session(fixture.cwd),
				env: { NORN_EXECUTABLE: executable },
			});
			assert.equal(result.code, 1);
			assert.equal(result.stdout, "");
			assert.match(result.stderr, /Norn introduction unavailable/);
			assert.ok(!result.stderr.includes("secret diagnostic"));
		});
	}
}

for (const intro of ["  ", "a".repeat(6_000)]) {
	test(`Claude Code rejects empty docs or combined context beyond the host limit (${intro.length})`, async (context) => {
		const fixture = await createFixture(context);
		const executable = join(fixture.root, "norn");
		await writeExecutable(
			executable,
			`process.stdout.write(JSON.stringify({ intro: ${JSON.stringify(intro)} }));`,
		);
		const result = await runHook({
			cwd: fixture.cwd,
			payload: session(fixture.cwd),
			env: { NORN_EXECUTABLE: executable },
		});
		assert.equal(result.code, 1);
		assert.equal(result.stdout, "");
	});
}

for (const payload of [null, {}, { hook_event_name: "PreToolUse" }]) {
	test(`Claude Code rejects invalid hook input: ${JSON.stringify(payload)}`, async (context) => {
		const fixture = await createFixture(context);
		const result = await runHook({
			cwd: fixture.cwd,
			payload,
			env: { NORN_EXECUTABLE: join(fixture.root, "missing") },
		});
		assert.equal(result.code, 1);
		assert.equal(result.stdout, "");
	});
}

test("Claude Code does not fall back from a missing selected executable to PATH", async (context) => {
	const fixture = await createFixture(context);
	await writeExecutable(
		join(fixture.root, "norn"),
		'process.stdout.write(JSON.stringify({ intro: "Wrong runtime" }));',
	);
	const result = await runHook({
		cwd: fixture.cwd,
		payload: session(fixture.cwd),
		env: {
			PATH: `${fixture.root}${delimiter}${process.env.PATH ?? ""}`,
			NORN_EXECUTABLE: join(fixture.root, "missing"),
		},
	});
	assert.equal(result.code, 1);
	assert.equal(result.stdout, "");
});

test("Claude Code marketplace hook runs from a relocated installation without dependencies", async (context) => {
	const fixture = await createFixture(context);
	const installationRoot = join(fixture.root, "installed plugin");
	for (const path of [
		".claude-plugin",
		"hooks",
		"packages/core/src/host-introduction.mjs",
	]) {
		await cp(join(packageRoot, path), join(installationRoot, path), {
			recursive: true,
		});
	}
	const marketplace = JSON.parse(
		await readFile(
			join(installationRoot, ".claude-plugin/marketplace.json"),
			"utf8",
		),
	);
	assert.equal(marketplace.name, "norn-adapters");
	const pluginRoot = join(installationRoot, marketplace.plugins[0].source);
	const manifest = JSON.parse(
		await readFile(join(pluginRoot, ".claude-plugin/plugin.json"), "utf8"),
	);
	assert.equal(manifest.name, marketplace.plugins[0].name);
	const hooks = JSON.parse(
		await readFile(join(pluginRoot, "hooks/hooks.json"), "utf8"),
	);
	assert.deepEqual(Object.keys(hooks.hooks), ["SessionStart"]);
	const [registration] = hooks.hooks.SessionStart;
	assert.equal(registration.matcher, "startup|clear|compact");
	assert.equal(registration.hooks.length, 1);
	const hook = registration.hooks[0];
	assert.equal(hook.type, "command");
	assert.equal(hook.timeout, 15);
	const executable = join(fixture.root, "runtime with spaces");
	await writeExecutable(
		executable,
		'process.stdout.write(JSON.stringify({ intro: process.argv[2] === "docs" ? "Installed runtime docs" : "" }));',
	);
	const result = await runHook({
		cwd: fixture.cwd,
		payload: session(fixture.cwd),
		command: hook.command,
		env: { CLAUDE_PLUGIN_ROOT: pluginRoot, NORN_EXECUTABLE: executable },
	});
	assert.equal(result.code, 0);
	assert.equal(result.stderr, "");
	assert.deepEqual(JSON.parse(result.stdout), {
		hookSpecificOutput: {
			hookEventName: "SessionStart",
			additionalContext:
				"<norn-docs-intro>\nInstalled runtime docs\n</norn-docs-intro>",
		},
	});
});

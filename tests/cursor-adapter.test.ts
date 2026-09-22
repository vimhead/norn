import assert from "node:assert/strict";
import { exec, execFile } from "node:child_process";
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
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "vitest";

const runExecutable = promisify(execFile);
const runCommand = promisify(exec);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const hookScript = join(
	packageRoot,
	".cursor-plugin/hooks/norn-session-start.mjs",
);

type HookResult = {
	stdout: string;
	stderr: string;
};

async function createFixture(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "norn-cursor-adapter-"));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "workspace");
	await mkdir(cwd);
	return { root, cwd };
}

async function writeExecutable(path: string, source: string) {
	await writeFile(path, `#!/usr/bin/env node\n${source}\n`);
	await chmod(path, 0o700);
}

async function runHook(input: {
	readonly cwd: string;
	readonly env?: NodeJS.ProcessEnv;
}): Promise<HookResult> {
	const { stdout, stderr } = await runExecutable(
		process.execPath,
		[hookScript],
		{
			env: { ...process.env, CURSOR_PROJECT_DIR: input.cwd, ...input.env },
			cwd: packageRoot,
		},
	);
	return { stdout, stderr };
}

test("Cursor session hook injects the runtime-selected Norn introduction", async (context) => {
	const fixture = await createFixture(context);
	const calledFrom = join(fixture.root, "called-from");
	await writeExecutable(
		join(fixture.root, "norn"),
		`
require("node:fs").writeFileSync(${JSON.stringify(calledFrom)}, process.cwd());
process.stdout.write(JSON.stringify({ intro: "Current Norn introduction" }));
`,
	);
	const result = await runHook({
		cwd: fixture.cwd,
		env: {
			PATH: `${fixture.root}${delimiter}${process.env.PATH ?? ""}`,
			NORN_EXECUTABLE: "",
		},
	});
	assert.equal(result.stderr, "");
	assert.deepEqual(JSON.parse(result.stdout), {
		additional_context:
			"<norn-docs-intro>\nCurrent Norn introduction\n</norn-docs-intro>",
	});
	assert.equal(
		await realpath(await readFile(calledFrom, "utf8")),
		await realpath(fixture.cwd),
	);
});

test("Cursor hook passes explicit executable paths as executable names", async (context) => {
	const fixture = await createFixture(context);
	const runtimeRoot = join(fixture.root, "other installation");
	await mkdir(runtimeRoot);
	const executable = join(runtimeRoot, "norn");
	await writeExecutable(
		executable,
		'process.stdout.write(JSON.stringify({ intro: "Custom runtime introduction" }));',
	);
	const result = await runHook({
		cwd: fixture.cwd,
		env: { NORN_EXECUTABLE: executable },
	});
	assert.equal(result.stderr, "");
	assert.deepEqual(JSON.parse(result.stdout), {
		additional_context:
			"<norn-docs-intro>\nCustom runtime introduction\n</norn-docs-intro>",
	});
});

const failures: [string, string][] = [
	[
		"nonzero exit",
		'process.stderr.write("secret diagnostic"); process.exit(1);',
	],
	["invalid JSON", 'process.stdout.write("secret diagnostic");'],
	["missing intro", 'process.stdout.write("{}");'],
	["wrong intro type", "process.stdout.write(JSON.stringify({ intro: 42 }));"],
	["empty intro", 'process.stdout.write(JSON.stringify({ intro: "  " }));'],
	[
		"oversized intro",
		`process.stdout.write(JSON.stringify({ intro: "a".repeat(16_385) }));`,
	],
];

for (const [label, source] of failures) {
	test(`${label} returns no context and does not leak subprocess diagnostics`, async (context) => {
		const fixture = await createFixture(context);
		const executable = join(fixture.root, "norn");
		await writeExecutable(executable, source);
		const result = await runHook({
			cwd: fixture.cwd,
			env: { NORN_EXECUTABLE: executable },
		});
		assert.deepEqual(JSON.parse(result.stdout), {});
		assert.ok(result.stderr.includes("Norn introduction unavailable"));
		assert.ok(!result.stderr.includes("secret diagnostic"));
	});
}

test("Cursor marketplace resolves a runnable sessionStart hook from a relocated root plugin", async (context) => {
	const fixture = await createFixture(context);
	const installationRoot = join(fixture.root, "installed plugin");
	await cp(
		join(packageRoot, ".cursor-plugin"),
		join(installationRoot, ".cursor-plugin"),
		{ recursive: true },
	);
	const marketplace = JSON.parse(
		await readFile(
			join(installationRoot, ".cursor-plugin/marketplace.json"),
			"utf8",
		),
	);
	assert.deepEqual(marketplace.plugins, [
		{
			name: "norn",
			source: ".",
			description:
				"Adds runtime-selected Norn documentation context to Cursor agent sessions.",
		},
	]);
	const pluginRoot = join(installationRoot, marketplace.plugins[0].source);
	const manifest = JSON.parse(
		await readFile(join(pluginRoot, ".cursor-plugin/plugin.json"), "utf8"),
	);
	assert.equal(manifest.name, "norn");
	assert.equal(manifest.hooks, "./.cursor-plugin/hooks/hooks.json");
	const hooks = JSON.parse(
		await readFile(join(pluginRoot, manifest.hooks), "utf8"),
	);
	assert.equal(hooks.version, 1);
	assert.deepEqual(hooks.hooks.sessionStart, [
		{
			command: "node ./.cursor-plugin/hooks/norn-session-start.mjs",
			timeout: 10,
		},
	]);
	const executable = join(fixture.root, "norn");
	const calledFrom = join(fixture.root, "called-from");
	await writeExecutable(
		executable,
		`
require("node:assert/strict").deepEqual(process.argv.slice(2), ["docs", "intro"]);
require("node:fs").writeFileSync(${JSON.stringify(calledFrom)}, process.cwd());
process.stdout.write(JSON.stringify({ intro: "Installed Norn introduction" }));
`,
	);
	const result = await runCommand(hooks.hooks.sessionStart[0].command, {
		cwd: pluginRoot,
		env: {
			...process.env,
			NORN_EXECUTABLE: executable,
			CURSOR_PROJECT_DIR: fixture.cwd,
		},
	});
	assert.equal(result.stderr, "");
	assert.deepEqual(JSON.parse(result.stdout), {
		additional_context:
			"<norn-docs-intro>\nInstalled Norn introduction\n</norn-docs-intro>",
	});
	assert.equal(
		await realpath(await readFile(calledFrom, "utf8")),
		await realpath(fixture.cwd),
	);
});

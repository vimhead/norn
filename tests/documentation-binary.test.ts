import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";
import type { NornRunInfo } from "@vimhead.dev/norn";
import { readProcessStdout } from "./helpers/process.ts";
import { collectDocumentationBundle, generateDocumentationAssets } from "../scripts/generate-documentation-assets.ts";
import { generatePiAssets } from "../scripts/generate-pi-assets.ts";

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const bun = join(packageRoot, "node_modules/.bin", process.platform === "win32" ? "bun.exe" : "bun");

test("compiled binary resolves complete offline docs without source and runs an extracted example", { timeout: 180_000 }, async context => {
	const root = await mkdtemp(join(tmpdir(), "norn-binary-documentation-"));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const buildRoot = join(root, "build");
	const detachedRoot = join(root, "standalone copy");
	await mkdir(buildRoot);
	await mkdir(detachedRoot);
	for (const path of ["packages/cli/src", "packages/cli/package.json", "packages/sdk/src", "packages/core/src", "docs", "examples", "README.md", "package.json", "tests/workflow-ref.test.ts"]) {
		await mkdir(dirname(join(buildRoot, path)), { recursive: true });
		await cp(join(packageRoot, path), join(buildRoot, path), { recursive: true, filter: source => !source.endsWith("documentation-assets.generated.ts") });
	}
	await symlink(join(packageRoot, "node_modules"), join(buildRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
	const version = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version;
	const commit = "b".repeat(40);
	await writeFile(join(buildRoot, "packages/cli/src/generated-build-info.ts"), `export const NORN_GENERATED_BUILD_INFO = ${JSON.stringify({ kind: "github-release-binary", version, commit, repository: "vimhead/norn", releaseTag: "tip", assetName: "norn-test", checksumAssetName: "norn-test.sha256" })} as const;\n`);
	await generatePiAssets({ packageRoot: buildRoot, outputPath: join(buildRoot, "packages/cli/src/bun/pi-assets.generated.ts") });
	await generateDocumentationAssets({ packageRoot: buildRoot, outputPath: join(buildRoot, "packages/cli/src/bun/documentation-assets.generated.ts"), assetRoot: join(buildRoot, "packages/cli/assets") });
	const expectedBundle = await collectDocumentationBundle({ packageRoot: buildRoot });
	const binary = join(detachedRoot, process.platform === "win32" ? "norn.exe" : "norn");
	await execute(bun, ["build", "--compile", join(buildRoot, "packages/cli/src/bun/cli.ts"), "--outfile", binary], { cwd: buildRoot, timeout: 120_000, maxBuffer: 1024 * 1024 });
	await rm(buildRoot, { recursive: true, force: true });
	const cacheRoot = join(root, "cache");
	const home = join(root, "home");
	const agentDir = join(home, ".norn", "agent");
	const piAgentDir = join(home, ".pi", "agent");
	const piAuth = JSON.stringify({ "outer-harness": { type: "api_key", key: "harness-only-test-key" } });
	await mkdir(piAgentDir, { recursive: true });
	await writeFile(join(piAgentDir, "auth.json"), piAuth, { mode: 0o600 });
	const environment = { SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: piAgentDir, PI_PACKAGE_DIR: "/unrelated-pi", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", NORN_PI_CACHE_DIR: join(root, "pi-assets"), NORN_DOCS_CACHE_DIR: cacheRoot, PATH: "", NODE_PATH: "" };
	const invoke = async (args: readonly string[], cwd = detachedRoot) => {
		const execution = execute(binary, args, { cwd, env: environment, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
		execution.child.stdin?.end();
		return JSON.parse((await execution).stdout);
	};
	assert.equal((await invoke(["version"])).build.commit, commit);
	assert.equal((await invoke(["commands", "inspect", "docs.inspect"])).command.id, "docs.inspect");
	assert.equal((await invoke(["commands", "inspect", "docs.intro"])).command.id, "docs.intro");
	await assert.rejects(access(cacheRoot), { code: "ENOENT" });
	const { intro } = await invoke(["docs", "intro"]);
	const invocation = JSON.parse(intro.match(/^Runtime argv .*: (.+)$/m)[1]);
	assert.deepEqual(invocation, [await realpath(binary)]);
	assert.equal(JSON.parse((await execute(invocation[0], [...invocation.slice(1), "version"], { cwd: detachedRoot, env: environment, timeout: 30_000 })).stdout).build.commit, commit);
	await rm(cacheRoot, { recursive: true, force: true });
	const responses = await Promise.all(Array.from({ length: 4 }, () => invoke(["docs", "inspect"])));
	const documentation = responses[0].documentation;
	for (const response of responses) assert.deepEqual(response.documentation, documentation);
	assert.equal(documentation.storage, "cache");
	assert.equal(documentation.commit, commit);
	assert.equal(documentation.version, version);
	assert.ok(intro.includes(JSON.stringify(documentation.paths.index)));
	assert.ok(intro.includes(JSON.stringify(documentation.paths.examples)));
	assert.equal((await invoke(["docs", "intro"])).intro, intro);
	for (const file of expectedBundle.files) {
		assert.deepEqual(await readFile(join(documentation.paths.root, file.path)), Buffer.from(file.content), file.path);
	}
	const projectRoot = join(root, "example-copy");
	await cp(join(documentation.paths.examples, "minimal-workflow"), projectRoot, { recursive: true });
	assert.equal((await invoke(["project", "inspect"], projectRoot)).isComplete, true);
	const launch = await new Promise<{ run: NornRunInfo }>((resolve, reject) => {
		const child = execFile(binary, ["runs", "start", "greeting.write"], { cwd: projectRoot, env: environment, timeout: 30_000 }, (error, stdout) => {
			if (error) reject(error);
			else { try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); } }
		});
		assert.ok(child.stdin);
		child.stdin.end(JSON.stringify({ params: { name: "Offline" } }));
	});
	const finished = (await invoke(["runs", "wait", launch.run.id], projectRoot)).run;
	assert.equal(finished.status, "completed", JSON.stringify(finished));
	assert.equal(await readFile(join(finished.path, "current/artifacts/greeting.txt"), "utf8"), "Hello, Offline!\n");
	await writeFile(join(projectRoot, "native.ts"), `
import { definePlugin, definePluginManifest } from "@vimhead.dev/norn";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { Compile } from "typebox/compile";
import { Check } from "typebox/schema";
const manifest = definePluginManifest({ id: "native", states: { count: Type.Integer() }, workflows: {
  check: { isEntrypoint: true, instructions: "Exercise detached TypeBox imports and decoding.", params: Type.Object({ count: Type.Decode(Type.String({ default: "41" }), value => Number(value) + 1) }) },
} });
export default definePlugin(manifest, { workflows: { check: { async execute(run, params) {
  const expected = Type.Literal(42);
  if (!Value.Check(expected, params.count) || !Compile(expected).Check(params.count) || !Check(expected, params.count)) throw new Error("Incorrect decoded count");
  await run.state.set(manifest.states.count, params.count);
  const count = await run.state.get(manifest.states.count);
  return run.complete({ data: { count } });
} } } });
`);
	await writeFile(join(projectRoot, "norn.project.json"), JSON.stringify({ plugins: ["./plugin.ts", "./native.ts"] }));
	const nativeLaunch = await invoke(["runs", "start", "native.check"], projectRoot);
	const nativeResult = (await invoke(["runs", "wait", nativeLaunch.run.id], projectRoot)).run;
	assert.equal(nativeResult.status, "completed", JSON.stringify(nativeResult));
	assert.deepEqual(nativeResult.outcome?.metadata?.data, { count: 42 });
	await writeFile(documentation.paths.index, "modified");
	await assert.rejects(invoke(["docs", "inspect"]), error => {
		assert.match(readProcessStdout(error), /cache is incomplete or modified/);
		return true;
	});
	await assert.rejects(invoke(["docs", "intro"]), error => {
		assert.match(readProcessStdout(error), /cache is incomplete or modified/);
		return true;
	});
	await rm(documentation.paths.root, { recursive: true, force: true });
	assert.equal((await invoke(["docs", "inspect"])).documentation.paths.root, documentation.paths.root);

	const invokePi = (args: string[]) => {
		const execution = execute(binary, ["pi", ...args], { cwd: detachedRoot, env: environment, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
		execution.child.stdin?.end();
		return execution;
	};
	const piManifest = JSON.parse(await readFile(join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
	assert.equal((await invokePi(["--version"])).stdout.trim(), piManifest.version);
	assert.match((await invokePi(["--help"])).stdout, /pi - AI coding assistant/);
	const oauthProbe = join(detachedRoot, "oauth-probe.ts");
	await cp(join(packageRoot, "tests/fixtures/pi-oauth-probe.ts"), oauthProbe);
	const oauthLogin = await invokePi(["--extension", oauthProbe, "--list-models", "openai-codex"]);
	assert.match(oauthLogin.stdout, /Codex OAuth login reached method selection/, oauthLogin.stderr);
	const providerPath = join(root, "installed provider");
	await cp(join(packageRoot, "tests/fixtures/pi-provider"), providerPath, { recursive: true });
	await invokePi(["install", providerPath]);
	const settingsPath = join(agentDir, "settings.json");
	const settings = JSON.parse(await readFile(settingsPath, "utf8"));
	assert.equal(await realpath(join(agentDir, settings.packages[0])), await realpath(providerPath));
	await writeFile(settingsPath, JSON.stringify({ ...settings, defaultProvider: "norn-offline", defaultModel: "fixture", retry: { enabled: false }, compaction: { enabled: false } }));
	await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "norn-offline": { type: "api_key", key: "offline-test-key" } }), { mode: 0o600 });
	assert.match((await invokePi(["--list-models", "norn-offline"])).stdout, /fixture/);
	const response = JSON.parse((await invokePi(["--no-session", "-p", "literal --help && echo untouched"])).stdout);
	assert.equal(response.prompt, "literal --help && echo untouched");
	assert.ok((await readFile(join(response.docs, "custom-provider.md"), "utf8")).includes("pi.registerProvider"));
	assert.equal(JSON.parse(await readFile(join(response.packageRoot, "package.json"), "utf8")).version, piManifest.version);
	await access(join(response.packageRoot, "theme/dark.json"));
	await access(join(response.packageRoot, "export-html/template.html"));
	const workerProject = join(root, "worker-project");
	await cp(join(packageRoot, "tests/fixtures/pi-worker-project"), workerProject, { recursive: true });
	const { run: workerRun } = await invoke(["runs", "start", "provider.check"], workerProject);
	const completedWorker = (await invoke(["runs", "wait", workerRun.id], workerProject)).run;
	assert.equal(completedWorker.status, "completed", JSON.stringify(completedWorker));
	assert.deepEqual(JSON.parse(await readFile(join(completedWorker.path, "current/artifacts/result.json"), "utf8")), { ok: true });
	assert.equal(await readFile(join(piAgentDir, "auth.json"), "utf8"), piAuth);
	await assert.rejects(access(join(piAgentDir, "settings.json")), { code: "ENOENT" });
	await writeFile(join(response.packageRoot, "theme/dark.json"), "modified");
	await assert.rejects(invokePi(["--version"]), error => {
		assert.match((error as { stderr: string }).stderr, /Bundled Pi assets are incomplete or modified/);
		return true;
	});
});

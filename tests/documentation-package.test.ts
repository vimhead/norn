import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";
import { packReleasePackages } from "../scripts/release-packages.ts";

const execute = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));

test("real npm tarballs provide public imports, exact dependencies, offline docs and an independent Pi adapter outside the checkout", { timeout: 240_000 }, async context => {
	const root = await mkdtemp(join(tmpdir(), "norn-packages-"));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const tarballs = join(root, "tarballs");
	const packages = await packReleasePackages({ workspaceRoot, outputDirectory: tarballs });
	assert.deepEqual(packages.map(pkg => pkg.name), ["@vimhead.dev/norn", "@vimhead.dev/norn-cli", "@vimhead.dev/pi-norn"]);
	const consumer = join(root, "consumer");
	await mkdir(consumer);
	await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
	await execute("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...packages.map(pkg => join(tarballs, pkg.filename)), "@types/node@26.2.0"], { cwd: consumer, timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
	const runtimeRoot = join(consumer, "node_modules/@vimhead.dev/norn-cli");
	const adapterRoot = join(consumer, "node_modules/@vimhead.dev/pi-norn");
	const libraryRoot = join(consumer, "node_modules/@vimhead.dev/norn");
	for (const packageRoot of [runtimeRoot, adapterRoot, libraryRoot]) {
		assert.equal((await lstat(packageRoot)).isSymbolicLink(), false);
		const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
		for (const section of [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
			assert.equal(section?.["@vimhead.dev/norn-core"], undefined);
		}
		for (const file of await readdir(join(packageRoot, "dist"), { recursive: true })) {
			if (!/\.(?:js|ts)$/.test(file)) continue;
			const content = await readFile(join(packageRoot, "dist", file), "utf8");
			assert.ok(!content.includes("@vimhead.dev/norn-core"), `${manifest.name}: private dependency escaped into ${file}`);
		}
	}
	const manifest = JSON.parse(await readFile(join(runtimeRoot, "package.json"), "utf8"));
	assert.equal(manifest.dependencies["@vimhead.dev/norn"], packages[0].version);
	const adapterManifest = JSON.parse(await readFile(join(adapterRoot, "package.json"), "utf8"));
	assert.deepEqual(adapterManifest.pi.extensions, ["./dist/index.js"]);
	assert.equal(adapterManifest.dependencies, undefined);
	const cli = join(runtimeRoot, "bin/norn.mjs");
	const cacheRoot = join(root, "unused-cache");
	const environment = { ...process.env, NORN_AGENT_DIR: join(root, "agent"), NORN_DOCS_CACHE_DIR: cacheRoot, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", NODE_PATH: "" };
	const invoke = async (args: readonly string[]) => JSON.parse((await execute(process.execPath, [cli, ...args], { cwd: consumer, env: environment, timeout: 30_000 })).stdout);
	const documentation = (await invoke(["docs", "inspect"])).documentation;
	const canonicalRuntime = await realpath(runtimeRoot);
	assert.equal(documentation.storage, "installation");
	assert.equal(documentation.version, packages[0].version);
	assert.equal(documentation.paths.root, join(canonicalRuntime, "assets"));
	assert.equal(documentation.paths.index, join(canonicalRuntime, "assets/docs/README.md"));
	for (const path of await readdir(documentation.paths.root, { recursive: true })) {
		if (!path.endsWith(".md")) continue;
		const content = await readFile(join(documentation.paths.root, path), "utf8");
		for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
			const link = match[1].split("#")[0];
			if (link && !/^[a-z]+:/i.test(link)) await access(resolve(dirname(join(documentation.paths.root, path)), link));
		}
	}
	const { intro } = await invoke(["docs", "intro"]);
	const invocation = JSON.parse(intro.match(/^Runtime argv .*: (.+)$/m)[1]);
	assert.deepEqual(invocation, [process.execPath, join(canonicalRuntime, "bin/norn.mjs")]);
	assert.ok(intro.includes(JSON.stringify(documentation.paths.index)));
	await assert.rejects(access(cacheRoot), { code: "ENOENT" });
	await writeFile(join(consumer, "consumer.ts"), `
import { definePlugin, definePluginManifest, workflowRefSchema, NornFileCoordinator, type NornRun } from "@vimhead.dev/norn";
import { createNornClient } from "@vimhead.dev/norn-cli/client";
import { Type } from "typebox";
declare const run: NornRun;
const files: NornFileCoordinator = run.resources.files;
const manifest = definePluginManifest({ id: "consumer", states: { count: Type.Integer() }, workflows: {
  test: { isEntrypoint: true, instructions: "Exercise package types.", params: Type.Object({
    count: Type.Decode(Type.String(), text => Number(text)),
    next: workflowRefSchema({ params: Type.Object({ report: Type.String() }) }),
  }) },
} });
const plugin = definePlugin(manifest, { workflows: { test: { async execute(run, params) {
  const count: number = params.count;
  await run.state.set(manifest.states.count, count);
  const saved: number = await run.state.get(manifest.states.count);
  return run.next(params.next.workflow, { ...params.next.forwardParams, report: String(saved) });
} } } });
run.next(manifest.workflows.test, { count: "1", next: "consumer.test" });
// @ts-expect-error Callers supply encoded inputs, not decoded values.
run.next(manifest.workflows.test, { count: 1, next: "consumer.test" });
// @ts-expect-error Direct state schemas retain their native value types.
run.state.set(manifest.states.count, "1");
const client = createNornClient({ spawnCwd: process.cwd() });
void [files, plugin, client];
`);
	await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true }, include: ["consumer.ts"] }));
	await execute(process.execPath, [join(workspaceRoot, "node_modules/typescript/bin/tsc"), "--project", join(consumer, "tsconfig.json")], { cwd: consumer, timeout: 30_000 });
	await cp(join(documentation.paths.examples, "minimal-workflow"), join(consumer, "workflow"), { recursive: true });
	const smoke = `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { definePlugin, definePluginManifest } from "@vimhead.dev/norn";
import { createNornClient } from "@vimhead.dev/norn-cli/client";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
assert.equal(typeof definePlugin, "function");
assert.equal(typeof definePluginManifest, "function");
const client = createNornClient({ spawnCwd: join(process.cwd(), "workflow") });
const started = await client.runs.start({ workflowId: "greeting.write", params: { name: "Packed" } });
const finished = await client.runs.wait(started.id);
assert.equal(finished.status, "completed", JSON.stringify(finished));
assert.equal(await readFile(join(finished.path, "current/artifacts/greeting.txt"), "utf8"), "Hello, Packed!\\n");
const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: ${JSON.stringify(join(root, "outer-agent"))}, settingsManager: SettingsManager.inMemory({ packages: [${JSON.stringify(adapterRoot)}] }) });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
assert.ok(loader.getExtensions().extensions.some(extension => extension.path.endsWith("pi-norn/dist/index.js")));
console.log("packed library, CLI and Pi adapter verified");
`;
	const result = await execute(process.execPath, ["--input-type=module", "--eval", smoke], { cwd: consumer, env: environment, timeout: 60_000 });
	assert.match(result.stdout, /packed library, CLI and Pi adapter verified/);
});

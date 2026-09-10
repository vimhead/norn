import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { collectDocumentationBundle, generateDocumentationAssets } from "../scripts/generate-documentation-assets.mjs";

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const bun = join(packageRoot, "node_modules/.bin", process.platform === "win32" ? "bun.exe" : "bun");

test("compiled binary resolves complete offline docs without source and runs an extracted example", { timeout: 180_000 }, async context => {
	const root = await mkdtemp(join(tmpdir(), "norn-binary-documentation-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const buildRoot = join(root, "build");
	const detachedRoot = join(root, "standalone copy");
	await mkdir(buildRoot);
	await mkdir(detachedRoot);
	for (const path of ["src", "docs", "examples", "skills", "README.md", "package.json", "tests/workflow-ref.test.mjs"]) {
		await mkdir(dirname(join(buildRoot, path)), { recursive: true });
		await cp(join(packageRoot, path), join(buildRoot, path), { recursive: true, filter: source => !source.endsWith("documentation-assets.generated.ts") });
	}
	await symlink(join(packageRoot, "node_modules"), join(buildRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
	const version = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version;
	const commit = "b".repeat(40);
	await writeFile(join(buildRoot, "src/generated-build-info.ts"), `export const NORN_GENERATED_BUILD_INFO = ${JSON.stringify({ kind: "github-release-binary", version, commit, repository: "vimhead/norn", releaseTag: "tip", assetName: "norn-test", checksumAssetName: "norn-test.sha256" })} as const;\n`);
	await generateDocumentationAssets({ packageRoot: buildRoot, outputPath: join(buildRoot, "src/bun/documentation-assets.generated.ts") });
	const expectedBundle = await collectDocumentationBundle({ packageRoot: buildRoot });
	const binary = join(detachedRoot, process.platform === "win32" ? "norn.exe" : "norn");
	await execute(bun, ["build", "--compile", join(buildRoot, "src/bun/cli.ts"), "--outfile", binary], { cwd: buildRoot, timeout: 120_000, maxBuffer: 1024 * 1024 });
	await rm(buildRoot, { recursive: true, force: true });
	const cacheRoot = join(root, "cache");
	const environment = { ...process.env, HOME: join(root, "home"), NORN_DOCS_CACHE_DIR: cacheRoot, PATH: "", NODE_PATH: "" };
	const invoke = async (args, cwd = detachedRoot) => JSON.parse((await execute(binary, args, { cwd, env: environment, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout);
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
	const launch = await new Promise((resolve, reject) => {
		const child = execFile(binary, ["runs", "start", "greeting.write"], { cwd: projectRoot, env: environment, timeout: 30_000 }, (error, stdout) => {
			if (error) reject(error);
			else { try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); } }
		});
		child.stdin.end(JSON.stringify({ params: { name: "Offline" } }));
	});
	const finished = (await invoke(["runs", "wait", launch.run.id], projectRoot)).run;
	assert.equal(finished.status, "completed", JSON.stringify(finished));
	assert.equal(await readFile(join(finished.path, "current/artifacts/greeting.txt"), "utf8"), "Hello, Offline!\n");
	await writeFile(documentation.paths.index, "modified");
	await assert.rejects(invoke(["docs", "inspect"]), error => {
		assert.match(error.stdout, /cache is incomplete or modified/);
		return true;
	});
	await assert.rejects(invoke(["docs", "intro"]), error => {
		assert.match(error.stdout, /cache is incomplete or modified/);
		return true;
	});
	await rm(documentation.paths.root, { recursive: true, force: true });
	assert.equal((await invoke(["docs", "inspect"])).documentation.paths.root, documentation.paths.root);
});

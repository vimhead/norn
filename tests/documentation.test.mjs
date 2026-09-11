import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createJiti } from "jiti";
import { collectDocumentationBundle, generateDocumentationAssets } from "../scripts/generate-documentation-assets.mjs";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { resolveNornDocumentation, resolveDocumentationCacheRoot } = await jiti.import("../src/documentation.ts");
const { validateDocumentationBundle, hashDocumentationBundle } = await jiti.import("../src/internal/documentation-bundle.ts");
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const build = { kind: "github-release-binary", version: "0.1.0", commit: "a".repeat(40), repository: "vimhead/norn", releaseTag: "tip", assetName: "norn-test", checksumAssetName: "norn-test.sha256" };
const bundle = { version: "0.1.0", files: [
	{ path: "README.md", content: "# Documentation\n" },
	{ path: "docs/README.md", content: "[Example](../examples/demo/plugin.ts)\n" },
	{ path: "skills/norn/SKILL.md", content: "# Skill\n" },
	{ path: "examples/demo/plugin.ts", content: "export const greeting = 'Héllo!';\n" },
] };

async function createFixture(context) {
	const root = await mkdtemp(join(tmpdir(), "norn-documentation-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	return { root, input: { source: { kind: "embedded", bundle }, build, cacheRoot: join(root, "cache") } };
}

test("local documentation resolves from the installation, without creating a cache", async context => {
	const { input } = await createFixture(context);
	const result = await resolveNornDocumentation({ ...input, source: { kind: "local", root: packageRoot } });
	assert.equal(result.storage, "installation");
	assert.equal(result.paths.root, packageRoot.replace(/[\\/]$/, ""));
	assert.equal(result.paths.index, join(packageRoot, "docs/README.md"));
	assert.equal(result.assetDigest, null);
	await assert.rejects(access(input.cacheRoot), { code: "ENOENT" });
	assert.deepEqual(Object.keys(result).sort(), ["assetDigest", "commit", "paths", "storage", "version"]);
	assert.equal(result.commit, build.commit);
	const unknown = await resolveNornDocumentation({ ...input, source: { kind: "local", root: packageRoot }, build: { ...build, commit: null } });
	assert.equal(unknown.commit, null);
});

test("embedded content is exact, cache reuse performs no rewrites, and links stay relative", async context => {
	const { input } = await createFixture(context);
	const first = await resolveNornDocumentation(input);
	assert.equal(first.storage, "cache");
	for (const file of bundle.files) assert.equal(await readFile(join(first.paths.root, file.path), "utf8"), file.content);
	const before = await lstat(first.paths.index);
	const second = await resolveNornDocumentation(input);
	assert.deepEqual(second, first);
	assert.equal((await lstat(second.paths.index)).mtimeMs, before.mtimeMs);
	await access(join(first.paths.docs, "../examples/demo/plugin.ts"));
	assert.deepEqual(await readdir(input.cacheRoot), [first.paths.root.split(/[\\/]/).at(-1)]);
});

test("parallel extractors publish one complete tree and ignore interrupted staging directories", async context => {
	const { input } = await createFixture(context);
	await mkdir(join(input.cacheRoot, ".extract-abandoned"), { recursive: true });
	const results = await Promise.all(Array.from({ length: 8 }, () => resolveNornDocumentation(input)));
	assert.equal(new Set(results.map(result => result.paths.root)).size, 1);
	assert.equal((await readdir(input.cacheRoot)).length, 2);
	for (const file of bundle.files) assert.equal(await readFile(join(results[0].paths.root, file.path), "utf8"), file.content);
});

test("content and build changes use separate caches, regardless of file order", async context => {
	const { input } = await createFixture(context);
	const first = await resolveNornDocumentation(input);
	assert.equal(hashDocumentationBundle(bundle), hashDocumentationBundle({ ...bundle, files: [...bundle.files].reverse() }));
	const changedBundle = { ...bundle, files: bundle.files.map(file => ({ ...file, content: file.content + "\n" })) };
	const changed = await resolveNornDocumentation({ ...input, source: { kind: "embedded", bundle: changedBundle } });
	const newBuild = await resolveNornDocumentation({ ...input, build: { ...build, commit: "b".repeat(40) } });
	assert.equal(new Set([first.paths.root, changed.paths.root, newBuild.paths.root]).size, 3);
	assert.notEqual(first.assetDigest, changed.assetDigest);
	await assert.rejects(resolveNornDocumentation({ ...input, build: { ...build, version: "other" } }), /version does not match/);
});

for (const mutation of ["modified", "missing", "extra", "directory"]) {
	test(`a ${mutation} cache fails closed rather than advertising or overwriting altered evidence`, async context => {
		const { input } = await createFixture(context);
		const result = await resolveNornDocumentation(input);
		if (mutation === "modified") await writeFile(result.paths.index, "changed");
		if (mutation === "missing") await rm(result.paths.index);
		if (mutation === "extra") await writeFile(join(result.paths.root, "extra.md"), "extra");
		if (mutation === "directory") await mkdir(join(result.paths.root, "extra"));
		await assert.rejects(resolveNornDocumentation(input), /cache is incomplete or modified/);
		if (mutation === "modified") assert.equal(await readFile(result.paths.index, "utf8"), "changed");
		await rm(result.paths.root, { recursive: true });
		const recovered = await resolveNornDocumentation(input);
		assert.equal(recovered.paths.root, result.paths.root);
		assert.equal(await readFile(recovered.paths.index, "utf8"), bundle.files[1].content);
	});
}

for (const target of ["file", "directory", "entry", "cacheRoot"]) {
	test(`a symlink at ${target} is rejected without changing its target`, { skip: process.platform === "win32" }, async context => {
		const { root, input } = await createFixture(context);
		const result = await resolveNornDocumentation(input);
		const outside = join(root, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "sentinel"), "untouched");
		const path = target === "file" ? result.paths.index : target === "directory" ? result.paths.docs : target === "entry" ? result.paths.root : input.cacheRoot;
		await rm(path, { recursive: true });
		await symlink(target === "file" ? join(outside, "sentinel") : outside, path);
		await assert.rejects(resolveNornDocumentation(input), /cache .*modified|cache root must be a real directory/);
		assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "untouched");
		assert.deepEqual(await readdir(outside), ["sentinel"]);
	});
}

test("byte verification does not conflate invalid UTF-8 with replacement characters", async context => {
	const { input } = await createFixture(context);
	const replacementBundle = { ...bundle, files: bundle.files.map(file => file.path === "README.md" ? { ...file, content: "\ufffd" } : file) };
	const replacementInput = { ...input, source: { kind: "embedded", bundle: replacementBundle } };
	const result = await resolveNornDocumentation(replacementInput);
	await writeFile(result.paths.readme, Buffer.from([0xff]));
	await assert.rejects(resolveNornDocumentation(replacementInput), /modified/);
});

for (const path of ["../escape", "/absolute", "C:/drive", "a\\b", "a/./b", "a//b", "CON.txt", "a/../b", "trailing."]) {
	test(`reject unsafe or nonportable bundle path ${path}`, () => {
		assert.throws(() => validateDocumentationBundle({ ...bundle, files: [...bundle.files, { path, content: "bad" }] }), /Invalid documentation asset path/);
	});
}

test("reject duplicate/case-colliding files, file-directory collisions and missing required assets", () => {
	for (const path of ["README.md", "readme.md", "docs"]) {
		assert.throws(() => validateDocumentationBundle({ ...bundle, files: [...bundle.files, { path, content: "bad" }] }), /Duplicate|collision/);
	}
	assert.throws(() => validateDocumentationBundle({ ...bundle, files: [] }), /Missing documentation asset/);
});

test("cache roots respect explicit override and native defaults", () => {
	assert.equal(resolveDocumentationCacheRoot({ platform: "darwin", home: "/home/test", environment: {} }), join("/home/test", "Library/Caches/norn/docs"));
	assert.equal(resolveDocumentationCacheRoot({ platform: "linux", home: "/home/test", environment: { XDG_CACHE_HOME: "/xdg" } }), join("/xdg", "norn/docs"));
	assert.equal(resolveDocumentationCacheRoot({ platform: "linux", home: "/home/test", environment: { XDG_CACHE_HOME: "relative" } }), join("/home/test", ".cache/norn/docs"));
	assert.equal(resolveDocumentationCacheRoot({ platform: "win32", home: "/home/test", environment: { LOCALAPPDATA: "/local" } }), join("/local", "norn/docs"));
	assert.equal(resolveDocumentationCacheRoot({ platform: "darwin", home: "/home/test", environment: { NORN_DOCS_CACHE_DIR: "/override" } }), resolve("/override"));
});

test("asset generation is deterministic, excludes itself, and includes every local Markdown link target", async context => {
	const { root } = await createFixture(context);
	const assets = await collectDocumentationBundle({ packageRoot });
	assert.ok(assets.files.some(file => file.path === "src/api.ts"));
	assert.ok(assets.files.some(file => file.path === "examples/minimal-workflow/.gitignore"));
	assert.ok(!assets.files.some(file => file.path.endsWith("documentation-assets.generated.ts") || file.path.includes("/.norn/")));
	const paths = new Set(assets.files.map(file => file.path));
	for (const file of assets.files.filter(file => file.path.endsWith(".md"))) {
		for (const match of file.content.matchAll(/\]\(([^)]+)\)/g)) {
			const link = match[1].split("#")[0];
			if (!link || /^[a-z]+:/i.test(link)) continue;
			const target = new URL(link, `file:///${file.path}`).pathname.slice(1);
			assert.ok(paths.has(target) || [...paths].some(path => path.startsWith(target.replace(/\/$/, "") + "/")), `${file.path}: ${link}`);
		}
	}
	const outputPath = join(root, "generated.ts");
	const first = await generateDocumentationAssets({ packageRoot, outputPath });
	const content = await readFile(outputPath, "utf8");
	const second = await generateDocumentationAssets({ packageRoot, outputPath });
	assert.deepEqual(first, second);
	assert.equal(await readFile(outputPath, "utf8"), content);
});

test("asset collection excludes runtime/dependency files and refuses symlinked assets", async context => {
	const { root } = await createFixture(context);
	for (const file of [...bundle.files, { path: "package.json", content: '{"version":"0.1.0"}' }, { path: "src/api.ts", content: "export {};" }, { path: "adapters/pi.ts", content: "export {};" }, { path: "tests/workflow-ref.test.mjs", content: "" },
		{ path: "examples/.norn/runs/private.json", content: "private run" },
		{ path: "examples/node_modules/dependency/index.ts", content: "dependency" },
		{ path: "examples/demo/auth.json", content: "credential" },
		{ path: "examples/demo/.env.json", content: "environment" },
		{ path: "examples/demo/key.pem", content: "key" },
	]) {
		await mkdir(join(root, ...file.path.split("/").slice(0, -1)), { recursive: true });
		await writeFile(join(root, file.path), file.content);
	}
	const collected = await collectDocumentationBundle({ packageRoot: root });
	assert.equal(collected.files.length, bundle.files.length + 2);
	assert.ok(!collected.files.some(file => file.path.startsWith("adapters/")));
	assert.ok(!collected.files.some(file => /private run|dependency|credential|environment|key/.test(file.content)));
	if (process.platform !== "win32") {
		await symlink(join(root, "README.md"), join(root, "docs/symlink.md"));
		await assert.rejects(collectDocumentationBundle({ packageRoot: root }), /must not be symlinks/);
	}
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

test("npm package file set preserves documentation links and resolves paths from the installed copy", { timeout: 60_000 }, async context => {
	const root = await mkdtemp(join(tmpdir(), "norn-package-documentation-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const packed = JSON.parse((await execute(npm, ["pack", "--dry-run", "--ignore-scripts", "--json"], { cwd: packageRoot, timeout: 45_000, maxBuffer: 20 * 1024 * 1024 })).stdout)[0];
	const packageFiles = new Set(packed.files.filter(file => !file.path.startsWith("node_modules/")).map(file => file.path));
	const installedRoot = join(root, "package");
	for (const path of packageFiles) {
		await mkdir(dirname(join(installedRoot, path)), { recursive: true });
		await copyFile(join(packageRoot, path), join(installedRoot, path));
	}
	for (const path of [...packageFiles].filter(path => path.endsWith(".md"))) {
		const content = await readFile(join(installedRoot, path), "utf8");
		for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
			const link = match[1].split("#")[0];
			if (!link || /^[a-z]+:/i.test(link)) continue;
			await access(resolve(dirname(join(installedRoot, path)), link));
		}
	}
	await symlink(join(packageRoot, "node_modules"), join(installedRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
	const cacheRoot = join(root, "unused-cache");
	const result = JSON.parse((await execute(process.execPath, [join(installedRoot, "bin/norn.mjs"), "docs", "inspect"], { cwd: root, env: { ...process.env, NORN_DOCS_CACHE_DIR: cacheRoot }, timeout: 30_000 })).stdout).documentation;
	assert.equal(result.storage, "installation");
	const canonicalRoot = await realpath(installedRoot);
	assert.equal(result.paths.root, canonicalRoot);
	assert.equal(result.paths.index, join(canonicalRoot, "docs/README.md"));
	await assert.rejects(access(cacheRoot), { code: "ENOENT" });
});

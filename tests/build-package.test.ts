import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";

const execute = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));

test("package builds isolate declaration roots and fail without publishing declarations for invalid source", { timeout: 30_000 }, async context => {
	const root = await mkdtemp(join(tmpdir(), "norn-declaration-build-"));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const packageRoot = join(root, "packages/example");
	const sourceRoot = join(packageRoot, "src");
	const outputRoot = join(packageRoot, "dist");
	const script = join(root, "scripts/build-package.ts");
	await mkdir(join(root, "scripts"), { recursive: true });
	await mkdir(join(sourceRoot, "nested"), { recursive: true });
	await mkdir(join(sourceRoot, "bun"), { recursive: true });
	await mkdir(join(root, "packages/unrelated/src"), { recursive: true });
	await symlink(join(workspaceRoot, "node_modules"), join(root, "node_modules"), "junction");
	await cp(join(workspaceRoot, "scripts/build-package.ts"), script);
	await cp(join(workspaceRoot, "tsconfig.json"), join(root, "tsconfig.json"));
	await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
	await writeFile(join(sourceRoot, "index.ts"), 'export type { Options } from "./nested/options.ts";\nexport const count: number = 1;\n');
	await writeFile(join(sourceRoot, "nested/options.ts"), "export type Options = { label: string };\n");
	await writeFile(join(sourceRoot, "bun/entry.ts"), 'export const invalid: number = "excluded binary source";\n');
	await writeFile(join(root, "packages/unrelated/src/index.ts"), 'export const invalid: number = "unrelated package";\n');

	await execute(process.execPath, [script], { cwd: packageRoot, timeout: 15_000 });
	assert.match(await readFile(join(outputRoot, "index.d.ts"), "utf8"), /export declare const count: number/);
	assert.match(await readFile(join(outputRoot, "nested/options.d.ts"), "utf8"), /label: string/);
	assert.match(await readFile(join(outputRoot, "index.js"), "utf8"), /count = 1/);
	await assert.rejects(access(join(outputRoot, "bun")), { code: "ENOENT" });
	assert.deepEqual((await readdir(join(root, "dist"))).filter(path => path.startsWith("declarations-")), []);

	await writeFile(join(sourceRoot, "index.ts"), 'export const count: number = "invalid";\n');
	await assert.rejects(execute(process.execPath, [script], { cwd: packageRoot, timeout: 15_000 }), error => {
		assert.ok(error instanceof Error && "stdout" in error);
		assert.match(String(error.stdout), /TS2322/);
		assert.match(error.message, /Declaration emission failed/);
		return true;
	});
	await assert.rejects(access(join(outputRoot, "index.d.ts")), { code: "ENOENT" });
	assert.deepEqual((await readdir(join(root, "dist"))).filter(path => path.startsWith("declarations-")), []);
});

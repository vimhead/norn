import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { NPM_REGISTRY, PUBLISHED_WORKSPACES } from "../scripts/release-packages.ts";

test("npm acceptance completes publication while the registry still returns 404", async () => {
	const result = await exercisePublication({ exitCodes: [0, 0, 0] });
	assert.equal(result.error, null);
	assert.deepEqual(result.publishedPackages, ["sdk.tgz", "cli.tgz", "pi-norn.tgz"]);
});

test("npm rejection fails publication and prevents publishing later packages", async () => {
	const result = await exercisePublication({ exitCodes: [0, 1] });
	assert.ok(result.error instanceof Error);
	assert.match(result.error.message, /npm publish failed \(1\)/);
	assert.deepEqual(result.publishedPackages, ["sdk.tgz", "cli.tgz"]);
});

async function exercisePublication(input: { readonly exitCodes: readonly number[] }): Promise<{ readonly error: unknown; readonly publishedPackages: readonly string[] }> {
	const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
	const version = "0.1.0-tip.1.1";
	const tarball = Buffer.from("release tarball fixture");
	const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
	const packageNames = ["@vimhead.dev/norn", "@vimhead.dev/norn-cli", "@vimhead.dev/pi-norn"];
	const packages = PUBLISHED_WORKSPACES.map((workspace, index) => ({ name: packageNames[index], version, filename: `${workspace}.tgz`, integrity }));
	const files = new Map<string, string | Buffer>([
		[join(workspaceRoot, "dist/npm/release.json"), JSON.stringify({ packages })],
	]);
	for (const [index, workspace] of PUBLISHED_WORKSPACES.entries()) {
		files.set(join(workspaceRoot, "packages", workspace, "package.json"), JSON.stringify({ name: packages[index].name, version }));
		files.set(join(workspaceRoot, "dist/npm", packages[index].filename), tarball);
	}
	const publishedPackages: string[] = [];
	const originalArgv = process.argv;
	const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
	vi.resetModules();
	vi.doMock("node:fs/promises", async importOriginal => ({
		...await importOriginal<typeof import("node:fs/promises")>(),
		readFile: async (path: string) => {
			const contents = files.get(path);
			if (contents === undefined) throw new Error(`Unexpected publication fixture path: ${path}`);
			return contents;
		},
	}));
	vi.doMock("node:child_process", async importOriginal => ({
		...await importOriginal<typeof import("node:child_process")>(),
		spawn: (command: string, args: string[]) => {
			assert.equal(command, "npm");
			assert.equal(args[0], "publish");
			assert.deepEqual(args.slice(2), ["--access", "public", "--tag", "tip", "--registry", NPM_REGISTRY]);
			publishedPackages.push(basename(args[1]));
			const exitCode = input.exitCodes[publishedPackages.length - 1];
			assert.notEqual(exitCode, undefined);
			const child = new EventEmitter();
			queueMicrotask(() => child.emit("exit", exitCode));
			return child;
		},
	}));
	vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
	process.argv = [process.execPath, join(workspaceRoot, "scripts/publish-packages.ts"), "--interactive"];
	try {
		await import("../scripts/publish-packages.ts");
		return { error: null, publishedPackages };
	} catch (error) {
		return { error, publishedPackages };
	} finally {
		process.argv = originalArgv;
		consoleLog.mockRestore();
		vi.unstubAllGlobals();
		vi.doUnmock("node:fs/promises");
		vi.doUnmock("node:child_process");
		vi.resetModules();
	}
}

import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "vitest";
import {
	resolveNornRuntime,
	RuntimeResolutionError,
} from "@vimhead.dev/norn-core/runtime-resolution";
import {
	writeLocalRuntime,
	writeRuntimeConfiguration,
} from "./helpers/local-runtime.ts";

async function createFixture(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "norn-runtime-resolution-"));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "workspace", "nested");
	await mkdir(cwd, { recursive: true });
	return { root, cwd };
}

function resolveRuntime(cwd: string) {
	return resolveNornRuntime({
		cwd,
		executableOverride: null,
		isProjectTrusted: true,
		nodeExecutable: process.execPath,
	});
}

test("an ancestor configuration selects a descendant dependency without changing cwd or executing package code", async (context) => {
	const { root, cwd } = await createFixture(context);
	const packageRoot = join(root, "tools with spaces", "workflows");
	const { scriptPath } = await writeLocalRuntime({ packageRoot });
	await writeRuntimeConfiguration({
		directory: root,
		packageRoot: "./tools with spaces/workflows",
	});
	assert.deepEqual(await resolveRuntime(cwd), {
		executable: process.execPath,
		args: [await realpath(scriptPath)],
	});
});

test("nearest configuration wins and package roots are relative to that file", async (context) => {
	const { root, cwd } = await createFixture(context);
	await writeRuntimeConfiguration({
		directory: root,
		packageRoot: "./missing",
	});
	const { scriptPath } = await writeLocalRuntime({
		packageRoot: join(dirname(cwd), "selected"),
	});
	await writeRuntimeConfiguration({
		directory: dirname(cwd),
		packageRoot: "./selected",
	});
	assert.deepEqual((await resolveRuntime(cwd)).args, [
		await realpath(scriptPath),
	]);
});

test("dependency lookup supports npm hoisting and pnpm symlinks without package.json exports", async (context) => {
	const { root, cwd } = await createFixture(context);
	const packageRoot = join(root, "workspace/packages/owner");
	const installationRoot = join(
		root,
		"store/version-1/node_modules/@vimhead.dev/norn-cli",
	);
	const { scriptPath } = await writeLocalRuntime({
		packageRoot,
		installationRoot,
	});
	const linkedInstallation = join(
		root,
		"workspace/node_modules/@vimhead.dev/norn-cli",
	);
	await mkdir(dirname(linkedInstallation), { recursive: true });
	await symlink(installationRoot, linkedInstallation, "dir");
	await writeRuntimeConfiguration({ directory: root, packageRoot });
	assert.deepEqual((await resolveRuntime(cwd)).args, [
		await realpath(scriptPath),
	]);
});

test("explicit executable selection takes precedence even over invalid repository configuration", async (context) => {
	const { root, cwd } = await createFixture(context);
	await writeFile(join(root, ".nornrc.json"), "invalid JSON");
	assert.deepEqual(
		await resolveNornRuntime({
			cwd,
			executableOverride: "/chosen runtime/norn",
			isProjectTrusted: true,
			nodeExecutable: process.execPath,
		}),
		{
			executable: "/chosen runtime/norn",
			args: [],
		},
	);
});

test("untrusted projects do not read repository selection", async (context) => {
	const { root, cwd } = await createFixture(context);
	await writeFile(join(root, ".nornrc.json"), "invalid JSON");
	assert.deepEqual(
		await resolveNornRuntime({
			cwd,
			executableOverride: null,
			isProjectTrusted: false,
			nodeExecutable: process.execPath,
		}),
		{ executable: "norn", args: [] },
	);
});

test("without a configuration adapters retain PATH selection", async (context) => {
	const { cwd } = await createFixture(context);
	assert.deepEqual(await resolveRuntime(cwd), { executable: "norn", args: [] });
});

for (const configuration of [
	"invalid JSON",
	"null",
	"[]",
	"{}",
	'{"runtime":{}}',
	'{"runtime":{"packageRoot":42}}',
	'{"runtime":{"packageRoot":" "}}',
	'{"runtime":{"packageRoot":".","version":"tip"}}',
	'{"runtime":{"packageRoot":"."},"unknown":true}',
]) {
	test(`invalid configuration fails rather than falling back: ${configuration}`, async (context) => {
		const { root, cwd } = await createFixture(context);
		await writeFile(join(root, ".nornrc.json"), configuration);
		await assert.rejects(resolveRuntime(cwd), RuntimeResolutionError);
	});
}

test("an unreadable nearest configuration does not fall back to a parent configuration", async (context) => {
	const { root, cwd } = await createFixture(context);
	await writeRuntimeConfiguration({ directory: root, packageRoot: "./owner" });
	await writeLocalRuntime({ packageRoot: join(root, "owner") });
	await symlink(join(root, "missing.json"), join(cwd, ".nornrc.json"));
	await assert.rejects(resolveRuntime(cwd), /Cannot read valid JSON/);
});

test("missing dependency owner and SDK-only packages report actionable failures", async (context) => {
	const { root, cwd } = await createFixture(context);
	const packageRoot = join(root, "owner");
	await writeRuntimeConfiguration({ directory: root, packageRoot: "./owner" });
	await assert.rejects(resolveRuntime(cwd), /package.json/);
	await mkdir(packageRoot);
	await writeFile(
		join(packageRoot, "package.json"),
		JSON.stringify({ devDependencies: { "@vimhead.dev/norn": "1.2.3" } }),
	);
	await assert.rejects(
		resolveRuntime(cwd),
		/must declare @vimhead.dev\/norn-cli/,
	);
});

test("missing installation and broken entrypoints fail without PATH fallback", async (context) => {
	const { root, cwd } = await createFixture(context);
	const packageRoot = join(root, "owner");
	const { scriptPath, installationRoot } = await writeLocalRuntime({
		packageRoot,
	});
	await writeRuntimeConfiguration({ directory: root, packageRoot: "./owner" });
	await rm(scriptPath);
	await assert.rejects(resolveRuntime(cwd), /Missing Norn CLI entrypoint/);
	await rm(installationRoot, { recursive: true });
	await assert.rejects(
		resolveRuntime(cwd),
		/Install that package's dependencies/,
	);
});

test("a broken package symlink does not select another ancestor installation", async (context) => {
	const { root, cwd } = await createFixture(context);
	await writeLocalRuntime({ packageRoot: root });
	const packageRoot = join(root, "owner");
	const { installationRoot } = await writeLocalRuntime({ packageRoot });
	await rm(installationRoot, { recursive: true });
	await symlink(join(root, "missing-installation"), installationRoot, "dir");
	await writeRuntimeConfiguration({ directory: root, packageRoot: "./owner" });
	await assert.rejects(
		resolveRuntime(cwd),
		/Reinstall the selected package's dependencies/,
	);
});

for (const manifest of [
	null,
	{},
	{ name: "unrelated", bin: { norn: "./bin/norn.mjs" } },
	{ name: "@vimhead.dev/norn-cli", bin: { norn: "../../outside.mjs" } },
]) {
	test(`invalid installed package fails: ${JSON.stringify(manifest)}`, async (context) => {
		const { root, cwd } = await createFixture(context);
		const { installationRoot } = await writeLocalRuntime({
			packageRoot: join(root, "owner"),
		});
		await writeRuntimeConfiguration({
			directory: root,
			packageRoot: "./owner",
		});
		await writeFile(
			join(installationRoot, "package.json"),
			JSON.stringify(manifest),
		);
		await assert.rejects(resolveRuntime(cwd), RuntimeResolutionError);
	});
}

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";
import { readProcessStdout } from "./helpers/process.ts";
import { renderNornDocumentationIntro, type NornDocumentationLocation } from "../src/documentation.ts";
const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = join(packageRoot, "bin/norn.mjs");
const documentation: NornDocumentationLocation = {
	storage: "installation", version: "0.1.0", commit: null, assetDigest: null,
	paths: {
		root: "/installation/norn", readme: "/installation/norn/README.md", index: "/installation/norn/docs/README.md",
		docs: "/installation/norn/docs", examples: "/installation/norn/examples",
	},
};

test("intro is compact, deterministic, and points to the index instead of copying topic manuals", () => {
	const input = { documentation, invocation: ["/runtime/node", "/installation/norn/bin/norn.mjs"] as const };
	const intro = renderNornDocumentationIntro(input);
	assert.equal(renderNornDocumentationIntro(input), intro);
	assert.ok(Buffer.byteLength(intro) < 2400);
	assert.ok(intro.split("\n").length <= 24);
	assert.match(intro, /harness-agnostic workflow runtime/);
	assert.match(intro, /agent-driven and code-driven TypeScript workflows with the Norn SDK/);
	assert.match(intro, /Norn agents are powered by the bundled, open-source and extensible Pi coding agent/);
	assert.match(intro, /authored, exercised, repaired, and reused during a task/);
	assert.match(intro, /Norn is optional/);
	assert.match(intro, /build commit: unknown/);
	for (const key of ["readme", "index", "docs", "examples"] as const) assert.ok(intro.includes(JSON.stringify(documentation.paths[key])));
	assert.ok(intro.includes('["workflows", "list"]'));
	assert.ok(intro.includes('["workflows", "inspect", "<workflow-id>"]'));
	assert.ok(!intro.includes("agents.md"), "topic-to-page mapping stays in the documentation index");
	assert.ok(!intro.includes("definePluginManifest"), "no authoring manual is embedded");
});

test("runtime argv and paths retain whitespace, quotes, backslashes and newlines without shell quoting", () => {
	const invocation = ['C:\\Program Files\\Norn\\norn.exe', 'a"b\nc'] as const;
	const unusualDocumentation = { ...documentation, commit: "a".repeat(40), paths: { ...documentation.paths, index: '/docs/quoted "path"\n/README.md' } };
	const intro = renderNornDocumentationIntro({ documentation: unusualDocumentation, invocation });
	const runtimeLine = intro.match(/^Runtime argv .*: (.+)$/m);
	const indexLine = intro.match(/^Documentation index and topic routing: (.+)$/m);
	assert.ok(runtimeLine && indexLine);
	assert.deepEqual(JSON.parse(runtimeLine[1]), invocation);
	assert.equal(JSON.parse(indexLine[1]), unusualDocumentation.paths.index);
	assert.ok(intro.includes(`build commit: "${unusualDocumentation.commit}"`));
});

test("source CLI produces intro outside a valid project and its invocation selects the same runtime", async context => {
	const root = await mkdtemp(join(tmpdir(), "norn-docs-intro-"));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "norn.project.json"), "not valid project JSON");
	const cacheRoot = join(root, "unused-cache");
	const options = { cwd: root, env: { ...process.env, NORN_DOCS_CACHE_DIR: cacheRoot }, timeout: 30_000 };
	const result = JSON.parse((await execute(process.execPath, [cli, "docs", "intro"], options)).stdout);
	assert.deepEqual(Object.keys(result), ["intro"]);
	const invocation = JSON.parse(result.intro.match(/^Runtime argv .*: (.+)$/m)[1]);
	assert.deepEqual(invocation, [process.execPath, cli] as const);
	const inspected = JSON.parse((await execute(invocation[0], [...invocation.slice(1), "docs", "inspect"], options)).stdout).documentation;
	assert.equal(result.intro, renderNornDocumentationIntro({ documentation: inspected, invocation }));
	await assert.rejects(access(cacheRoot), { code: "ENOENT" });
	await assert.rejects(access(join(root, ".norn")), { code: "ENOENT" });
	const metadata = JSON.parse((await execute(process.execPath, [cli, "commands", "inspect", "docs.intro"], options)).stdout).command;
	assert.equal(metadata.usage, "norn docs intro");
	assert.match((await execute(process.execPath, [cli, "help", "docs", "intro"], options)).stdout, /norn docs intro/);
	await assert.rejects(execute(process.execPath, [cli, "docs", "intro", "unexpected"], options), error => {
		assert.match(readProcessStdout(error), /does not accept CLI arguments/);
		return true;
	});
});

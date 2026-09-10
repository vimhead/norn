import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { renderNornDocumentationIntro } = await jiti.import("../src/documentation.ts");
const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = join(packageRoot, "bin/norn.mjs");
const documentation = {
	storage: "installation", version: "0.1.0", commit: null, assetDigest: null,
	paths: {
		root: "/installation/norn", readme: "/installation/norn/README.md", index: "/installation/norn/docs/README.md",
		docs: "/installation/norn/docs", examples: "/installation/norn/examples", skill: "/installation/norn/skills/norn/SKILL.md",
	},
};

test("intro is compact, deterministic, and points to the index instead of copying topic manuals", () => {
	const input = { documentation, invocation: ["/runtime/node", "/installation/norn/bin/norn.mjs"] };
	const intro = renderNornDocumentationIntro(input);
	assert.equal(renderNornDocumentationIntro(input), intro);
	assert.ok(Buffer.byteLength(intro) < 2400);
	assert.ok(intro.split("\n").length <= 24);
	assert.match(intro, /authored, exercised, repaired, and reused during a task/);
	assert.match(intro, /Norn is optional/);
	assert.match(intro, /build commit: unknown/);
	for (const key of ["readme", "index", "docs", "examples", "skill"]) assert.ok(intro.includes(JSON.stringify(documentation.paths[key])));
	assert.ok(intro.includes('["workflows", "list"]'));
	assert.ok(intro.includes('["workflows", "inspect", "<workflow-id>"]'));
	assert.ok(!intro.includes("agents.md"), "topic-to-page mapping stays in the documentation index");
	assert.ok(!intro.includes("definePluginManifest"), "no authoring manual is embedded");
});

test("runtime argv and paths retain whitespace, quotes, backslashes and newlines without shell quoting", () => {
	const invocation = ['C:\\Program Files\\Norn\\norn.exe', 'a"b\nc'];
	const unusualDocumentation = { ...documentation, commit: "a".repeat(40), paths: { ...documentation.paths, index: '/docs/quoted "path"\n/README.md' } };
	const intro = renderNornDocumentationIntro({ documentation: unusualDocumentation, invocation });
	assert.deepEqual(JSON.parse(intro.match(/^Runtime argv .*: (.+)$/m)[1]), invocation);
	assert.equal(JSON.parse(intro.match(/^Documentation index and topic routing: (.+)$/m)[1]), unusualDocumentation.paths.index);
	assert.ok(intro.includes(`build commit: "${unusualDocumentation.commit}"`));
});

test("source CLI produces intro outside a valid project and its invocation selects the same runtime", async context => {
	const root = await mkdtemp(join(tmpdir(), "norn-docs-intro-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "norn.project.json"), "not valid project JSON");
	const cacheRoot = join(root, "unused-cache");
	const options = { cwd: root, env: { ...process.env, NORN_DOCS_CACHE_DIR: cacheRoot }, timeout: 30_000 };
	const result = JSON.parse((await execute(process.execPath, [cli, "docs", "intro"], options)).stdout);
	assert.deepEqual(Object.keys(result), ["intro"]);
	const invocation = JSON.parse(result.intro.match(/^Runtime argv .*: (.+)$/m)[1]);
	assert.deepEqual(invocation, [process.execPath, cli]);
	const inspected = JSON.parse((await execute(invocation[0], [...invocation.slice(1), "docs", "inspect"], options)).stdout).documentation;
	assert.equal(result.intro, renderNornDocumentationIntro({ documentation: inspected, invocation }));
	await assert.rejects(access(cacheRoot), { code: "ENOENT" });
	await assert.rejects(access(join(root, ".norn")), { code: "ENOENT" });
	const metadata = JSON.parse((await execute(process.execPath, [cli, "commands", "inspect", "docs.intro"], options)).stdout).command;
	assert.equal(metadata.usage, "norn docs intro");
	assert.match((await execute(process.execPath, [cli, "help", "docs", "intro"], options)).stdout, /norn docs intro/);
	await assert.rejects(execute(process.execPath, [cli, "docs", "intro", "unexpected"], options), error => {
		assert.match(error.stdout, /does not accept CLI arguments/);
		return true;
	});
});

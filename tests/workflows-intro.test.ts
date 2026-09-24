import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test, type TestContext } from "vitest";
import { renderNornWorkflowsIntro } from "../packages/cli/src/workflows-intro.ts";
import { readProcessStdout } from "./helpers/process.ts";

const execute = promisify(execFile);
const cli = fileURLToPath(
	new URL("../packages/cli/bin/norn.mjs", import.meta.url),
);

async function createFixture(context: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "norn-workflows-intro-"));
	context.onTestFinished(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "nested");
	await mkdir(cwd);
	const invoke = async (args: readonly string[]) =>
		execute(process.execPath, [cli, ...args], { cwd, timeout: 30_000 });
	const introduce = async () =>
		JSON.parse((await invoke(["workflows", "intro"])).stdout);
	const configure = async (workflows: readonly string[]) =>
		writeFile(
			join(root, "norn.project.json"),
			JSON.stringify({ version: 1, workflows }),
		);
	return { root, invoke, introduce, configure };
}

function workflowModule(instructions: string | false): string {
	return `
import { workflowScope } from "@vimhead.dev/norn";
import { Type } from "typebox";
const scope = workflowScope({ name: "example" });
export default [scope.workflow({
  name: "brief",
  entrypoint: ${JSON.stringify(instructions === false ? false : { instructions })},
  args: Type.Object({ task: Type.String() }),
  execute() { throw new Error("Discovery must not execute workflows"); },
})];
`;
}

test("renderer omits empty catalogues and XML-escapes entrypoint fields", () => {
	const internal = {
		id: "internal",
		isEntrypoint: false,
		configKey: "internal",
	};
	assert.equal(renderNornWorkflowsIntro([]), "");
	assert.equal(renderNornWorkflowsIntro([internal]), "");
	const intro = renderNornWorkflowsIntro([
		internal,
		{
			id: "a<&>\"'",
			isEntrypoint: true,
			configKey: "entry",
			instructions: 'Use when comparing "a" & <b>\'s output.\nKeep evidence.',
		},
	]);
	assert.ok(
		intro.startsWith(
			"The following Norn workflows are available in the current project.",
		),
	);
	assert.ok(intro.includes("`workflows inspect <id>`"));
	assert.ok(intro.includes("`workflows list`"));
	assert.ok(intro.includes("<id>a&lt;&amp;&gt;&quot;&apos;</id>"));
	assert.ok(
		intro.includes(
			"<instructions>Use when comparing &quot;a&quot; &amp; &lt;b&gt;&apos;s output.\nKeep evidence.</instructions>",
		),
	);
	assert.ok(!intro.includes("internal"));
});

test("CLI advertises fresh entrypoints from the nearest project without creating run state", async (context) => {
	const fixture = await createFixture(context);
	assert.deepEqual(await fixture.introduce(), { intro: "" });
	await fixture.configure([]);
	assert.deepEqual(await fixture.introduce(), { intro: "" });
	const source = join(fixture.root, "workflow.ts");
	await fixture.configure(["./workflow.ts"]);
	await writeFile(source, workflowModule(false));
	assert.deepEqual(await fixture.introduce(), { intro: "" });
	await writeFile(
		source,
		workflowModule("Use when you need a research brief & citations."),
	);
	const { intro } = await fixture.introduce();
	assert.ok(intro.includes("<available_norn_workflows>"));
	assert.ok(intro.includes("<id>example.brief</id>"));
	assert.ok(
		intro.includes(
			"<instructions>Use when you need a research brief &amp; citations.</instructions>",
		),
	);
	await writeFile(
		source,
		workflowModule("Use when you need the updated capability."),
	);
	const updated = await fixture.introduce();
	assert.ok(updated.intro.includes("updated capability"));
	assert.ok(!updated.intro.includes("research brief"));
	await writeFile(source, workflowModule(false));
	assert.deepEqual(await fixture.introduce(), { intro: "" });
	await assert.rejects(access(join(fixture.root, ".norn")), { code: "ENOENT" });
	const metadata = JSON.parse(
		(await fixture.invoke(["commands", "inspect", "workflows.intro"])).stdout,
	).command;
	assert.equal(metadata.usage, "norn workflows intro");
	assert.match(
		(await fixture.invoke(["help", "workflows", "intro"])).stdout,
		/norn workflows intro/,
	);
	await assert.rejects(
		fixture.invoke(["workflows", "intro", "unexpected"]),
		(error) => {
			assert.match(readProcessStdout(error), /does not accept CLI arguments/);
			return true;
		},
	);
});

test("CLI fails on invalid configuration or incomplete discovery instead of advertising partial entrypoints", async (context) => {
	const fixture = await createFixture(context);
	await writeFile(join(fixture.root, "norn.project.json"), "invalid JSON");
	await assert.rejects(fixture.introduce());
	await fixture.configure(["./valid.ts", "./missing.ts"]);
	await writeFile(
		join(fixture.root, "valid.ts"),
		workflowModule("Use when testing complete discovery."),
	);
	await assert.rejects(fixture.introduce(), (error) => {
		const response = readProcessStdout(error);
		assert.match(response, /NORN_PROJECT_INVALID/);
		assert.match(response, /missing.ts/);
		assert.ok(!response.includes("<available_norn_workflows>"));
		return true;
	});
	await fixture.configure(["./broken.ts"]);
	await writeFile(
		join(fixture.root, "broken.ts"),
		'throw new Error("broken registration");',
	);
	await assert.rejects(fixture.introduce(), (error) => {
		assert.match(readProcessStdout(error), /broken registration/);
		return true;
	});
});

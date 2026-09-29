import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeLocalRuntime(input: {
	packageRoot: string;
	installationRoot?: string;
	intro?: string;
}): Promise<{ scriptPath: string; installationRoot: string }> {
	const installationRoot =
		input.installationRoot ??
		join(input.packageRoot, "node_modules/@vimhead.dev/norn-cli");
	await mkdir(join(installationRoot, "bin"), { recursive: true });
	await mkdir(input.packageRoot, { recursive: true });
	await writeFile(
		join(input.packageRoot, "package.json"),
		JSON.stringify({
			private: true,
			devDependencies: { "@vimhead.dev/norn-cli": "1.2.3" },
		}),
	);
	await writeFile(
		join(installationRoot, "package.json"),
		JSON.stringify({
			name: "@vimhead.dev/norn-cli",
			version: "1.2.3",
			bin: { norn: "./bin/norn.mjs" },
			exports: {},
		}),
	);
	const scriptPath = join(installationRoot, "bin/norn.mjs");
	await writeFile(
		scriptPath,
		`
import assert from "node:assert/strict";
assert.equal(process.argv[3], "intro");
assert.ok(["docs", "workflows"].includes(process.argv[2]));
process.stdout.write(JSON.stringify({ intro: process.argv[2] === "docs"
	? ${JSON.stringify(input.intro ?? "Project-local runtime")} + "\\nRuntime argv: " + JSON.stringify([process.execPath, process.argv[1]])
	: "Workspace: " + process.cwd() }));
`,
	);
	return { scriptPath, installationRoot };
}

export async function writeRuntimeConfiguration(input: {
	directory: string;
	packageRoot: string;
}): Promise<void> {
	await writeFile(
		join(input.directory, ".nornrc.json"),
		JSON.stringify({ runtime: { packageRoot: input.packageRoot } }),
	);
}

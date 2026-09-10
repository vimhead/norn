import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { validateSkillPackage } from "../scripts/validate-skill-package.mjs";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));

async function createPackageFixture(context) {
	const packageRoot = await mkdtemp(join(tmpdir(), "norn-skill-package-"));
	context.after(() => rm(packageRoot, { recursive: true, force: true }));
	for (const name of ["skills", "README.md", "package.json"]) {
		await cp(join(sourceRoot, name), join(packageRoot, name), { recursive: true });
	}
	return packageRoot;
}

test("the published skill validates", async () => {
	const result = await validateSkillPackage({ packageRoot: sourceRoot });
	assert.equal(result.name, "norn");
	assert.ok(result.rules > 0);
});

for (const { name, transform } of [
	{ name: "missing description", transform: text => text.replace(/^description:.*\n/m, "") },
	{ name: "incorrect name", transform: text => text.replace("name: norn", "name: other") },
	{ name: "missing else branch", transform: text => text.replace(/ELSE[^|]+/, "") },
	{ name: "empty example", transform: text => text.replace(/(\| IF [^\n]+?\|)[^|]+\|/, "$1 |") },
	{ name: "oversized body", transform: text => text + "x".repeat(8001) },
	{ name: "excessive lines", transform: text => text + "\n".repeat(101) + "end" },
	{ name: "duplicate rule", transform: text => text + text.split("\n").find(line => line.startsWith("| IF ")) + "\n" },
]) {
	test(`rejects ${name}`, async context => {
		const packageRoot = await createPackageFixture(context);
		const path = join(packageRoot, "skills/norn/SKILL.md");
		await writeFile(path, transform(await readFile(path, "utf8")));
		await assert.rejects(validateSkillPackage({ packageRoot }));
	});
}

test("rejects stale extra skills", async context => {
	const packageRoot = await createPackageFixture(context);
	await mkdir(join(packageRoot, "skills/norn-workflow-operation"));
	await assert.rejects(validateSkillPackage({ packageRoot }));
});

test("rejects an unlinked skill", async context => {
	const packageRoot = await createPackageFixture(context);
	await writeFile(join(packageRoot, "README.md"), "# Package\n");
	await assert.rejects(validateSkillPackage({ packageRoot }));
});

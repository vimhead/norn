import assert from "node:assert/strict";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export async function validateSkillPackage({ packageRoot }) {
	const skillsRoot = join(packageRoot, "skills");
	assert.deepEqual((await readdir(skillsRoot)).sort(), ["norn"], "Ship one self-contained norn skill");
	const skillDirectory = join(skillsRoot, "norn");
	assert.deepEqual(await readdir(skillDirectory), ["SKILL.md"], "Keep the skill self-contained");
	const skill = await readFile(join(skillDirectory, "SKILL.md"), "utf8");
	const frontmatter = skill.match(/^---\nname: ([a-z0-9-]+)\ndescription: ([^\n]+)\n---\n/);
	assert.ok(frontmatter, "Declare name and description frontmatter");
	assert.equal(frontmatter[1], "norn", "Match the discoverable skill name");
	assert.ok(frontmatter[2].startsWith("Use when "), "Describe the activation condition");
	assert.ok(frontmatter[2].length <= 1024, "Keep activation metadata within the skill specification");
	const bytes = Buffer.byteLength(skill, "utf8");
	const lines = skill.trimEnd().split("\n");
	assert.ok(bytes <= 8000, "Keep the loaded skill within its 8 KB context budget");
	assert.ok(lines.length <= 100, "Keep the skill within its 100-line budget");
	assert.ok(lines.includes("| Rule | GOOD | BAD |"), "Use conditional rules with paired examples");
	const rules = lines.filter(line => line.startsWith("| IF "));
	assert.ok(rules.length > 0, "Include decision rules");
	assert.equal(new Set(rules).size, rules.length, "Do not duplicate rules");
	for (const rule of rules) {
		const cells = rule.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim());
		assert.equal(cells.length, 3, "Each rule needs Rule, GOOD and BAD cells");
		assert.ok(cells.every(Boolean), "Do not leave a rule or example empty");
		assert.match(cells[0], /^IF .+, THEN .+\bELSE\b.+/, "Make both branches explicit");
	}
	const readme = await readFile(join(packageRoot, "README.md"), "utf8");
	assert.ok(readme.includes("(skills/norn/SKILL.md)"), "Link the installed skill from the README");
	const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	assert.deepEqual(manifest.pi.skills, ["./skills"], "Expose the skill directory to Pi package discovery");
	assert.ok(manifest.files.includes("skills"), "Include skills in the package");
	return { name: "norn", rules: rules.length, lines: lines.length, bytes };
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && await realpath(process.argv[1]) === await realpath(scriptPath)) {
	const result = await validateSkillPackage({ packageRoot: fileURLToPath(new URL("..", import.meta.url)) });
	console.log(`${result.name}: ${result.rules} rules, ${result.lines} lines, ${result.bytes} bytes`);
}

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export const PUBLISHED_WORKSPACES = ["sdk", "cli", "pi-norn"] as const;
export const NPM_REGISTRY = "https://registry.npmjs.org";
const execute = promisify(execFile);

export type PackedReleasePackage = {
	readonly name: string;
	readonly version: string;
	readonly filename: string;
	readonly integrity: string;
};

export function assertTipVersion(version: string): void {
	const numericIdentifier = "(?:0|[1-9]\\d*)";
	const pattern = new RegExp(`^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}-tip\\.${numericIdentifier}(?:\\.${numericIdentifier})?$`);
	if (!pattern.test(version)) throw new Error(`Expected an immutable tip prerelease version, received: ${version}`);
}

export async function packReleasePackages(input: { readonly workspaceRoot: string; readonly outputDirectory: string }): Promise<readonly PackedReleasePackage[]> {
	await mkdir(input.outputDirectory, { recursive: true });
	const packages: PackedReleasePackage[] = [];
	for (const workspace of PUBLISHED_WORKSPACES) {
		const directory = join(input.workspaceRoot, "packages", workspace);
		const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
		if (manifest.private || typeof manifest.name !== "string") throw new Error(`Invalid publishable workspace: ${workspace}`);
		assertTipVersion(manifest.version);
		if (packages.some(pkg => pkg.version !== manifest.version)) throw new Error("Release package versions must match");
		const { stdout } = await execute("pnpm", ["pack", "--pack-destination", input.outputDirectory, "--json"], { cwd: directory, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
		const packed = JSON.parse(stdout) as { filename: string };
		const filename = packed.filename.split(/[\\/]/).at(-1)!;
		const tarball = await readFile(join(input.outputDirectory, filename));
		packages.push({ name: manifest.name, version: manifest.version, filename, integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}` });
	}
	return packages;
}

export function verifyExistingPublication(input: { readonly expected: PackedReleasePackage; readonly integrity: string | null; readonly tipVersion: string | null }): boolean {
	if (input.integrity === null) return false;
	if (input.integrity !== input.expected.integrity) throw new Error(`Published artifact differs: ${input.expected.name}@${input.expected.version}`);
	if (input.tipVersion !== input.expected.version) throw new Error(`Published version is not tip; prepare a new release version: ${input.expected.name}@${input.expected.version}`);
	return true;
}

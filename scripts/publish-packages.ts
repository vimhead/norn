import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTipVersion, NPM_REGISTRY, PUBLISHED_WORKSPACES, verifyExistingPublication, type PackedReleasePackage } from "./release-packages.ts";

const [mode, ...extra] = process.argv.slice(2);
if (extra.length > 0 || !["--trusted", "--interactive"].includes(mode)) throw new Error("Usage: pnpm release:publish <--trusted|--interactive>");
if (mode === "--trusted" && (process.env.GITHUB_ACTIONS !== "true" || !process.env.ACTIONS_ID_TOKEN_REQUEST_URL)) throw new Error("Trusted publication requires GitHub Actions OIDC");
const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const tarballRoot = join(workspaceRoot, "dist/npm");
const release = JSON.parse(await readFile(join(tarballRoot, "release.json"), "utf8")) as { packages: PackedReleasePackage[] };
if (release.packages.length !== PUBLISHED_WORKSPACES.length) throw new Error("Incomplete release package set");
const pending: PackedReleasePackage[] = [];

for (const [index, pkg] of release.packages.entries()) {
	assertTipVersion(pkg.version);
	const manifest = JSON.parse(await readFile(join(workspaceRoot, "packages", PUBLISHED_WORKSPACES[index], "package.json"), "utf8"));
	if (pkg.name !== manifest.name || pkg.version !== manifest.version || pkg.version !== release.packages[0].version || !/^[a-z0-9.-]+\.tgz$/.test(pkg.filename)) throw new Error("Release manifest does not match the workspaces");
	const tarball = await readFile(join(tarballRoot, pkg.filename));
	if (`sha512-${createHash("sha512").update(tarball).digest("base64")}` !== pkg.integrity) throw new Error(`Changed release tarball: ${pkg.filename}`);
	const existing = await readRegistryPackage({ name: pkg.name, selector: pkg.version });
	const tip = existing === null ? null : await readRegistryPackage({ name: pkg.name, selector: "tip" });
	if (!verifyExistingPublication({ expected: pkg, integrity: existing?.dist.integrity ?? null, tipVersion: tip?.version ?? null })) pending.push(pkg);
}

for (const pkg of pending) {
	await publishTarball(join(tarballRoot, pkg.filename));
}
console.log(`npm tip publication completed for ${release.packages[0].version}`);

async function readRegistryPackage(input: { readonly name: string; readonly selector: string }): Promise<{ version: string; dist: { integrity: string } } | null> {
	const response = await fetch(`${NPM_REGISTRY}/${encodeURIComponent(input.name)}/${encodeURIComponent(input.selector)}`, { signal: AbortSignal.timeout(30_000), headers: { "cache-control": "no-cache" } });
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`Registry lookup failed for ${input.name}: HTTP ${response.status}`);
	const metadata = await response.json() as { version?: unknown; dist?: { integrity?: unknown } };
	if (typeof metadata.version !== "string" || typeof metadata.dist?.integrity !== "string") throw new Error(`Invalid registry metadata: ${input.name}`);
	return { version: metadata.version, dist: { integrity: metadata.dist.integrity } };
}

async function publishTarball(path: string): Promise<void> {
	const args = ["publish", path, "--access", "public", "--tag", "tip", "--registry", NPM_REGISTRY, ...(mode === "--trusted" ? ["--provenance"] : [])];
	await new Promise<void>((resolve, reject) => {
		const child = spawn("npm", args, { cwd: workspaceRoot, stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", code => code === 0 ? resolve() : reject(new Error(`npm publish failed (${code}); retry with a new immutable tip version`)));
	});
}

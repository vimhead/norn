import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NornBuildInfo } from "../packages/cli/src/build-info.ts";
import { assertTipVersion, PUBLISHED_WORKSPACES } from "./release-packages.ts";

export async function prepareRelease(input: {
	readonly workspaceRoot: string;
	readonly version: string;
	readonly commit: string;
	readonly binaryAsset: string | null;
}): Promise<void> {
	assertTipVersion(input.version);
	if (!/^[a-f0-9]{40}$/.test(input.commit))
		throw new Error("Release commit must be a full Git SHA");
	if (
		input.binaryAsset !== null &&
		!/^norn-[a-z0-9-]+(?:\.exe)?$/.test(input.binaryAsset)
	)
		throw new Error("Invalid binary release asset name");
	const manifestPaths = [
		"package.json",
		...PUBLISHED_WORKSPACES.map(
			(workspace) => `packages/${workspace}/package.json`,
		),
	];
	for (const path of manifestPaths) {
		const absolutePath = join(input.workspaceRoot, path);
		const manifest = JSON.parse(await readFile(absolutePath, "utf8"));
		await writeFile(
			absolutePath,
			`${JSON.stringify({ ...manifest, version: input.version }, null, 2)}\n`,
		);
	}
	const build: NornBuildInfo =
		input.binaryAsset === null
			? {
					kind: "npm-registry",
					version: input.version,
					commit: input.commit,
					packageSpec: "@vimhead.dev/norn-cli@tip",
					upgrade: {
						supported: false,
						reason:
							"Update @vimhead.dev/norn-cli@tip through your package manager in its existing installation scope (npm install -g only for global npm installations).",
					},
				}
			: {
					kind: "github-release-binary",
					version: input.version,
					commit: input.commit,
					repository: "vimhead/norn",
					releaseTag: "tip",
					assetName: input.binaryAsset,
					checksumAssetName: `${input.binaryAsset}.sha256`,
				};
	await writeFile(
		join(input.workspaceRoot, "packages/cli/src/generated-build-info.ts"),
		`import type { NornBuildInfo } from "./build-info.ts";\n\nexport const NORN_GENERATED_BUILD_INFO = ${JSON.stringify(build, null, 2)} as const satisfies NornBuildInfo;\n`,
	);
}

if (
	process.argv[1] &&
	(await realpath(process.argv[1])) === fileURLToPath(import.meta.url)
) {
	const [version, commit, binaryAsset, ...extra] = process.argv.slice(2);
	if (!version || !commit || extra.length > 0)
		throw new Error(
			"Usage: pnpm release:prepare <version> <commit> [binary-asset-name]",
		);
	await prepareRelease({
		workspaceRoot: fileURLToPath(new URL("..", import.meta.url)),
		version,
		commit,
		binaryAsset: binaryAsset ?? null,
	});
}

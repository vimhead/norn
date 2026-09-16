import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import type { PiAssetFile } from "../src/internal/pi-assets.ts";

const ASSET_LOCATIONS = [
	["package.json", "package.json"],
	["README.md", "README.md"],
	["CHANGELOG.md", "CHANGELOG.md"],
	["docs", "docs"],
	["examples", "examples"],
	["dist/modes/interactive/theme", "theme"],
	["dist/modes/interactive/assets", "assets"],
	["dist/core/export-html", "export-html"],
] as const;

async function collectPiAssets(input: { readonly source: string; readonly target: string; readonly files: PiAssetFile[] }): Promise<void> {
	const stat = await lstat(input.source);
	if (stat.isSymbolicLink()) throw new Error(`Pi assets must not be symlinks: ${input.source}`);
	if (stat.isDirectory()) {
		for (const entry of await readdir(input.source)) {
			await collectPiAssets({ source: join(input.source, entry), target: `${input.target}/${entry}`, files: input.files });
		}
	} else if (stat.isFile()) {
		input.files.push({ path: input.target, content: (await readFile(input.source)).toString("base64") });
	} else {
		throw new Error(`Unsupported Pi asset: ${input.source}`);
	}
}

export async function generatePiAssets(input: { readonly packageRoot: string; readonly outputPath: string }): Promise<void> {
	const piRoot = await realpath(join(input.packageRoot, "node_modules/@earendil-works/pi-coding-agent"));
	const files: PiAssetFile[] = [];
	for (const [source, target] of ASSET_LOCATIONS) {
		await collectPiAssets({ source: join(piRoot, source), target, files });
	}
	files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
	const archive = gzipSync(JSON.stringify(files)).toString("base64");
	await mkdir(dirname(input.outputPath), { recursive: true });
	await writeFile(input.outputPath, `export const piAssetArchive = ${JSON.stringify(archive)};\n`, "utf8");
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	await generatePiAssets({ packageRoot, outputPath: join(packageRoot, "src/bun/pi-assets.generated.ts") });
}

import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDocumentationBundle, hashDocumentationBundle, type NornDocumentationBundle, type NornDocumentationFile } from "../packages/cli/src/internal/documentation-bundle.ts";

const ASSET_ROOTS = ["README.md", "docs", "setup", "examples", "packages/sdk/src", "packages/cli/src", "packages/core/src", "tests/workflow-ref.test.ts"];
const EXCLUDED_DIRECTORIES = new Set([".git", ".norn", "node_modules", "dist"]);
const TEXT_EXTENSIONS = new Set([".md", ".ts", ".mjs", ".json"]);
const GENERATED_ASSET_PATH = "packages/cli/src/bun/documentation-assets.generated.ts";

export async function collectDocumentationBundle(input: { readonly packageRoot: string }): Promise<NornDocumentationBundle> {
	const files: NornDocumentationFile[] = [];
	for (const path of ASSET_ROOTS) await collectDocumentationFiles({ packageRoot: input.packageRoot, path, files });
	files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
	const { version }: { version: string } = JSON.parse(await readFile(join(input.packageRoot, "packages/cli/package.json"), "utf8"));
	const bundle = { version, files };
	validateDocumentationBundle(bundle);
	return bundle;
}

async function collectDocumentationFiles(input: { readonly packageRoot: string; readonly path: string; readonly files: NornDocumentationFile[] }): Promise<void> {
	const { packageRoot, path, files } = input;
	const absolutePath = join(packageRoot, path);
	const stat = await lstat(absolutePath);
	if (stat.isSymbolicLink()) throw new Error(`Documentation assets must not be symlinks: ${path}`);
	if (stat.isDirectory()) {
		for (const entry of await readdir(absolutePath, { withFileTypes: true })) {
			if (EXCLUDED_DIRECTORIES.has(entry.name) || entry.name === "auth.json" || entry.name.startsWith(".env")) continue;
			await collectDocumentationFiles({ packageRoot, path: `${path}/${entry.name}`, files });
		}
		return;
	}
	if (path === GENERATED_ASSET_PATH || path === "packages/cli/src/bun/pi-assets.generated.ts") return;
	if (!stat.isFile() || (!TEXT_EXTENSIONS.has(extname(path)) && !path.endsWith("/.gitignore"))) return;
	files.push({ path, content: await readFile(absolutePath, "utf8") });
}

export async function generateDocumentationAssets(input: { readonly packageRoot: string; readonly outputPath: string; readonly assetRoot: string }): Promise<{ files: number; bytes: number; digest: string }> {
	const bundle = await collectDocumentationBundle({ packageRoot: input.packageRoot });
	const content = `import type { NornDocumentationBundle } from "../internal/documentation-bundle.ts";\n\nexport const documentationAssets: NornDocumentationBundle = ${JSON.stringify(bundle)};\n`;
	await mkdir(dirname(input.outputPath), { recursive: true });
	await writeFile(input.outputPath, content, "utf8");
	const assetRoot = input.assetRoot;
	await rm(assetRoot, { recursive: true, force: true });
	for (const file of bundle.files) {
		const path = join(assetRoot, file.path);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, file.content, "utf8");
	}
	await writeFile(join(assetRoot, "package.json"), `${JSON.stringify({ version: bundle.version })}\n`);
	return { files: bundle.files.length, bytes: Buffer.byteLength(content), digest: hashDocumentationBundle(bundle) };
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	const result = await generateDocumentationAssets({ packageRoot, outputPath: join(packageRoot, GENERATED_ASSET_PATH), assetRoot: join(packageRoot, "packages/cli/assets") });
	console.log(`Embedded documentation: ${result.files} files, ${result.bytes} bytes, sha256 ${result.digest}`);
}

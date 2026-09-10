import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { validateDocumentationBundle, hashDocumentationBundle } = await jiti.import("../src/internal/documentation-bundle.ts");
const ASSET_ROOTS = ["README.md", "docs", "adapters", "examples", "skills", "src", "tests/workflow-ref.test.mjs"];
const EXCLUDED_DIRECTORIES = new Set([".git", ".norn", "node_modules", "dist"]);
const TEXT_EXTENSIONS = new Set([".md", ".ts", ".mjs", ".json"]);
const GENERATED_ASSET_PATH = "src/bun/documentation-assets.generated.ts";

export async function collectDocumentationBundle({ packageRoot }) {
	const files = [];
	for (const path of ASSET_ROOTS) await collectDocumentationFiles({ packageRoot, path, files });
	files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
	const { version } = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	const bundle = { version, files };
	validateDocumentationBundle(bundle);
	return bundle;
}

async function collectDocumentationFiles({ packageRoot, path, files }) {
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
	if (path === GENERATED_ASSET_PATH) return;
	if (!stat.isFile() || (!TEXT_EXTENSIONS.has(extname(path)) && !path.endsWith("/.gitignore"))) return;
	files.push({ path, content: await readFile(absolutePath, "utf8") });
}

export async function generateDocumentationAssets({ packageRoot, outputPath }) {
	const bundle = await collectDocumentationBundle({ packageRoot });
	const content = `import type { NornDocumentationBundle } from "../internal/documentation-bundle.ts";\n\nexport const documentationAssets: NornDocumentationBundle = ${JSON.stringify(bundle)};\n`;
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, content, "utf8");
	return { files: bundle.files.length, bytes: Buffer.byteLength(content), digest: hashDocumentationBundle(bundle) };
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	const result = await generateDocumentationAssets({ packageRoot, outputPath: join(packageRoot, GENERATED_ASSET_PATH) });
	console.log(`Embedded documentation: ${result.files} files, ${result.bytes} bytes, sha256 ${result.digest}`);
}

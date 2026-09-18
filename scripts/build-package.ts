import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = process.cwd();
const sourceRoot = join(packageRoot, "src");
const outputRoot = join(packageRoot, "dist");
const coreRoot = join(workspaceRoot, "packages/core/src");
const sourcePaths = (await readdir(sourceRoot, { recursive: true }))
	.filter(path => path.endsWith(".ts") && !path.startsWith(`bun${sep}`))
	.map(path => join(sourceRoot, path));

await rm(outputRoot, { recursive: true, force: true });
await build({
	entryPoints: sourcePaths,
	outbase: sourceRoot,
	outdir: outputRoot,
	bundle: true,
	packages: "external",
	platform: "node",
	format: "esm",
	target: "node22",
	plugins: [{
		name: "inline-private-core",
		setup(builder) {
			builder.onResolve({ filter: /^@vimhead\.dev\/norn-core\// }, args => ({
				path: fileURLToPath(import.meta.resolve(args.path)),
				external: false,
			}));
			builder.onResolve({ filter: /^\./ }, args => {
				if (args.importer.startsWith(`${coreRoot}${sep}`)) return;
				return { path: args.path.replace(/\.ts$/, ".js"), external: true };
			});
		},
	}],
});
await emitPackageDeclarations();

async function emitPackageDeclarations(): Promise<void> {
	const stagingParent = join(workspaceRoot, "dist");
	await mkdir(stagingParent, { recursive: true });
	const stagingRoot = await mkdtemp(join(stagingParent, "declarations-"));
	try {
		const configPath = join(stagingRoot, "tsconfig.json");
		const declarationRoot = join(stagingRoot, "output");
		await writeFile(configPath, JSON.stringify({
			extends: join(workspaceRoot, "tsconfig.json"),
			compilerOptions: {
				rootDir: workspaceRoot,
				outDir: declarationRoot,
				noEmit: false,
				noEmitOnError: true,
				declaration: true,
				emitDeclarationOnly: true,
				rewriteRelativeImportExtensions: true,
			},
			files: sourcePaths,
			include: [],
		}));
		const compilerPath = join(dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))), "bin/tsc");
		const result = spawnSync(process.execPath, [compilerPath, "--project", configPath], { cwd: workspaceRoot, stdio: "inherit" });
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(`Declaration emission failed: ${packageRoot} (exit ${result.status}, signal ${result.signal})`);
		await cp(join(declarationRoot, relative(workspaceRoot, sourceRoot)), outputRoot, { recursive: true });
	} finally {
		await rm(stagingRoot, { recursive: true, force: true });
	}
}

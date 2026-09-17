import { mkdirSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

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
emitPackageDeclarations();

function emitPackageDeclarations(): void {
	const configPath = join(workspaceRoot, "tsconfig.json");
	const config = ts.readConfigFile(configPath, ts.sys.readFile);
	if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, workspaceRoot);
	const declarationRoot = join(workspaceRoot, "dist/declarations");
	const packageDeclarationRoot = join(declarationRoot, relative(workspaceRoot, sourceRoot));
	const program = ts.createProgram(sourcePaths, {
		...parsed.options,
		rootDir: workspaceRoot,
		outDir: declarationRoot,
		noEmit: false,
		declaration: true,
		emitDeclarationOnly: true,
		rewriteRelativeImportExtensions: true,
	});
	const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
	if (diagnostics.length > 0) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
		getCanonicalFileName: path => path,
		getCurrentDirectory: () => packageRoot,
		getNewLine: () => "\n",
	}));
	const result = program.emit(undefined, (path, content) => {
		const packagePath = relative(packageDeclarationRoot, path);
		if (packagePath.startsWith(`..${sep}`)) return;
		const outputPath = resolve(outputRoot, packagePath);
		mkdirSync(dirname(outputPath), { recursive: true });
		writeFileSync(outputPath, content);
	});
	if (result.emitSkipped) throw new Error(`Declaration emission failed: ${packageRoot}`);
}

import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const CLI_PACKAGE_NAME = "@vimhead.dev/norn-cli";

export class RuntimeResolutionError extends Error {}

export async function resolveNornRuntime({
	cwd,
	executableOverride,
	isProjectTrusted,
	nodeExecutable,
}) {
	if (executableOverride !== null) {
		if (typeof executableOverride !== "string" || !executableOverride.trim())
			throw new RuntimeResolutionError(
				"Norn executable override must be a nonempty executable path or name.",
			);
		return { executable: executableOverride, args: [] };
	}
	if (!isProjectTrusted) return { executable: "norn", args: [] };
	const configPath = await findAncestorEntry({
		cwd,
		relativePath: ".nornrc.json",
	});
	if (configPath === null) return { executable: "norn", args: [] };
	const packageRoot = await readRuntimePackageRoot(configPath);
	const scriptPath = await resolvePackageEntrypoint(packageRoot);
	return { executable: nodeExecutable, args: [scriptPath] };
}

async function readRuntimePackageRoot(configPath) {
	const configuration = await readManifest(configPath);
	if (
		!isRecord(configuration) ||
		Object.keys(configuration).some((key) => key !== "runtime") ||
		!isRecord(configuration.runtime) ||
		Object.keys(configuration.runtime).some((key) => key !== "packageRoot") ||
		typeof configuration.runtime.packageRoot !== "string" ||
		!configuration.runtime.packageRoot.trim()
	)
		throw new RuntimeResolutionError(
			`Invalid ${JSON.stringify(configPath)}: expected { "runtime": { "packageRoot": "./path/to/package" } }.`,
		);
	return resolve(dirname(configPath), configuration.runtime.packageRoot);
}

async function resolvePackageEntrypoint(packageRoot) {
	const owner = await readManifest(join(packageRoot, "package.json"));
	if (
		!isRecord(owner) ||
		![
			owner.dependencies,
			owner.devDependencies,
			owner.optionalDependencies,
		].some(
			(dependencies) =>
				isRecord(dependencies) &&
				typeof dependencies[CLI_PACKAGE_NAME] === "string",
		)
	)
		throw new RuntimeResolutionError(
			`The package at ${JSON.stringify(packageRoot)} must declare ${CLI_PACKAGE_NAME} as a dependency or devDependency.`,
		);
	const packagePath = await findAncestorEntry({
		cwd: packageRoot,
		relativePath: `node_modules/${CLI_PACKAGE_NAME}`,
	});
	if (packagePath === null)
		throw new RuntimeResolutionError(
			`Cannot find ${CLI_PACKAGE_NAME} from ${JSON.stringify(packageRoot)}. Install that package's dependencies and retry.`,
		);
	const manifestPath = join(packagePath, "package.json");
	const installedManifestPath = await realpath(manifestPath).catch(() => {
		throw new RuntimeResolutionError(
			`Cannot resolve the installed CLI at ${JSON.stringify(manifestPath)}. Reinstall the selected package's dependencies.`,
		);
	});
	const installed = await readManifest(installedManifestPath);
	const entrypoint = isRecord(installed?.bin) ? installed.bin.norn : undefined;
	if (
		installed?.name !== CLI_PACKAGE_NAME ||
		typeof entrypoint !== "string" ||
		!entrypoint.trim() ||
		isAbsolute(entrypoint)
	)
		throw new RuntimeResolutionError(
			`Invalid Norn CLI manifest at ${JSON.stringify(installedManifestPath)}: expected a relative bin.norn entrypoint.`,
		);
	const installationRoot = dirname(installedManifestPath);
	const scriptPath = resolve(installationRoot, entrypoint);
	if (!scriptPath.startsWith(`${installationRoot}${sep}`))
		throw new RuntimeResolutionError(
			`Norn CLI entrypoint must be inside ${JSON.stringify(installationRoot)}.`,
		);
	try {
		if (!(await stat(scriptPath)).isFile()) throw new Error();
	} catch {
		throw new RuntimeResolutionError(
			`Missing Norn CLI entrypoint at ${JSON.stringify(scriptPath)}. Reinstall the selected package's dependencies.`,
		);
	}
	return scriptPath;
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readManifest(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		throw new RuntimeResolutionError(
			`Cannot read valid JSON from ${JSON.stringify(path)}. Check the selected package and configuration.`,
		);
	}
}

async function findAncestorEntry({ cwd, relativePath }) {
	let directory = resolve(cwd);
	while (true) {
		const candidate = join(directory, relativePath);
		try {
			await lstat(candidate);
			return candidate;
		} catch (error) {
			if (error.code !== "ENOENT")
				throw new RuntimeResolutionError(
					`Cannot inspect ${JSON.stringify(candidate)}.`,
				);
		}
		const parent = dirname(directory);
		if (parent === directory) return null;
		directory = parent;
	}
}

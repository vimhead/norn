import * as nornModule from "@vimhead.dev/norn";
import { isWorkflowPlugin, type NornDispose, type NornPluginDiagnostic, type NornProjectInfo, type NornProjectInspection, type NornProjectPluginInfo, type NornWorkflowCatalogInfo, type NornWorkflowInspection, type NornWorkflowPlugin, type NornWorkflowPluginInfo } from "@vimhead.dev/norn";
import { isNodeError } from "@vimhead.dev/norn-core/errors";
import * as nornFilesModule from "@vimhead.dev/norn/files";
import * as nornSchemaModule from "@vimhead.dev/norn/schema";
import { inspectSchema } from "@vimhead.dev/norn/schema";
import * as nornSeerModule from "@vimhead.dev/norn/seer";
import { resolveSeerModeConfig, type NornResolvedSeerModeConfig } from "@vimhead.dev/norn/seer";
import { createJiti } from "jiti/static";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import * as typeboxModule from "typebox";
import { Type, type StaticDecode } from "typebox";
import * as typeboxCompileModule from "typebox/compile";
import * as typeboxSchemaModule from "typebox/schema";
import * as typeboxValueModule from "typebox/value";
import { AssertError, Value } from "typebox/value";
import { errorMessage, NornProjectLoadError } from "./internal/errors.ts";
import { NornMemoryWorkflowState } from "./internal/state-store.ts";
import { decodePluginConfiguration, NornWorkflowRegistry, type NornRegisteredWorkflow } from "./internal/workflow-registry.ts";

export const NORN_PROJECT_FILE_NAME = "norn.project.json";

const seerModeConfigSchema = Type.Object({
	writableRoots: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});
const nornConfigSchema = Type.Object({
	plugins: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
	includes: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
	config: Type.Record(Type.String(), Type.Unknown(), { default: {} }),
});
const nornProjectConfigSchema = Type.Object({
	...nornConfigSchema.properties,
	version: Type.Literal(1, { default: 1 }),
	seerMode: Type.Optional(seerModeConfigSchema),
});

type NornConfig = StaticDecode<typeof nornConfigSchema> & { readonly seerMode?: never };
type NornProjectConfig = StaticDecode<typeof nornProjectConfigSchema>;

type NornConfigFile = {
	readonly path: string;
	readonly root: string;
	readonly config: NornConfig;
};

export type NornProject = {
	readonly cwd: string;
	readonly projectPath: string;
	readonly projectRoot: string;
	readonly configPath: string;
	readonly configRoot: string;
	readonly config: NornProjectConfig;
	readonly configFiles: readonly NornConfigFile[];
	readonly projectConfig: Record<string, unknown>;
	readonly seerMode?: NornResolvedSeerModeConfig;
};

export type NornLoadedProject = NornProject & {
	readonly plugins: readonly NornWorkflowPlugin[];
	readonly pluginInfos: readonly NornProjectPluginInfo[];
	readonly registry: NornWorkflowRegistry;
	readonly workflows: readonly NornRegisteredWorkflow[];
	readonly state: NornMemoryWorkflowState;
};

type LoadedNornWorkflowPlugin = {
	readonly plugin: NornWorkflowPlugin;
	readonly info: NornProjectPluginInfo;
};

export async function loadNornProject(cwd: string): Promise<NornLoadedProject> {
	const { project, diagnostics } = await collectNornProject(cwd);
	if (diagnostics.length > 0) throw new NornProjectLoadError({ diagnostics });
	return project;
}

export async function discoverNornProject(cwd: string): Promise<NornProjectInspection & NornWorkflowCatalogInfo> {
	const { project, diagnostics } = await collectNornProject(cwd);
	return { project: buildProjectInfo(project), workflows: project.registry.list(), isComplete: diagnostics.length === 0, diagnostics };
}

export async function inspectNornWorkflow(input: { readonly cwd: string; readonly workflowId: string }): Promise<NornWorkflowInspection> {
	const { project, diagnostics } = await collectNornProject(input.cwd);
	const summary = project.registry.list().find(workflow => workflow.id === input.workflowId);
	if (!summary) {
		if (diagnostics.length === 0) throw new Error(`Unknown workflow: ${input.workflowId}`);
		return { workflow: null, isComplete: false, diagnostics };
	}
	const info = summary.plugin;
	if (!info?.path || !info.configPath) throw new Error(`Loaded workflow lacks plugin source: ${input.workflowId}`);
	try {
		return { workflow: project.registry.inspect(input.workflowId) ?? null, isComplete: diagnostics.length === 0, diagnostics };
	} catch (error) {
		return { workflow: null, isComplete: false, diagnostics: [...diagnostics, createPluginDiagnostic({
			source: { configPath: info.configPath, pluginPath: info.path, pluginId: info.id },
			workflowId: input.workflowId, stage: "schema", error,
		})] };
	}
}

function buildProjectInfo(project: NornLoadedProject): NornProjectInfo {
	return {
		cwd: project.cwd, projectPath: project.projectPath, projectRoot: project.projectRoot,
		configPath: project.configPath, configRoot: project.configRoot,
		configFiles: project.configFiles.map(file => file.path), plugins: project.pluginInfos,
		seerMode: project.seerMode ?? null,
	};
}

export async function findNornProject(cwd: string): Promise<NornProject> {
	const projectPath = await findNearestNornProject(cwd);
	const projectRootConfig = await readNornProjectConfigFile(projectPath);
	const configFiles = await loadIncludedNornConfigFiles(projectRootConfig, new Set([projectRootConfig.path]));
	return {
		cwd: resolve(cwd),
		projectPath: projectRootConfig.path,
		projectRoot: projectRootConfig.root,
		configPath: projectRootConfig.path,
		configRoot: projectRootConfig.root,
		config: projectRootConfig.config,
		configFiles,
		projectConfig: mergeProjectConfig(configFiles),
		seerMode: resolveSeerModeConfig({ configPath: projectRootConfig.path, configRoot: projectRootConfig.root, seerMode: projectRootConfig.config.seerMode }),
	};
}

async function findNearestNornProject(cwd: string): Promise<string> {
	let current = resolve(cwd);
	while (true) {
		const projectPath = join(current, NORN_PROJECT_FILE_NAME);
		try {
			await access(projectPath);
			return projectPath;
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		}
		const parent = dirname(current);
		if (parent === current) throw new Error(`Could not find ${NORN_PROJECT_FILE_NAME} from ${cwd}`);
		current = parent;
	}
}

type NornProjectConfigFile = {
	readonly path: string;
	readonly root: string;
	readonly config: NornProjectConfig;
};

async function loadIncludedNornConfigFiles(projectFile: NornProjectConfigFile, visitedPaths: Set<string>): Promise<NornConfigFile[]> {
	const includedConfigFiles = await Promise.all(projectFile.config.includes.map(async (includePath) => {
		const configPaths = await expandIncludePath(projectFile.root, includePath);
		return Promise.all(configPaths.map(readNornConfigFile));
	}));
	const descendants = await Promise.all(includedConfigFiles.flat().map((includedConfigFile) => loadNornConfigTree(includedConfigFile, visitedPaths)));
	return [createProjectConfigEntry(projectFile), ...descendants.flat()];
}

async function loadNornConfigTree(configFile: NornConfigFile, visitedPaths: Set<string>): Promise<NornConfigFile[]> {
	if (visitedPaths.has(configFile.path)) return [];
	visitedPaths.add(configFile.path);
	const includedConfigFiles = await Promise.all(configFile.config.includes.map(async (includePath) => {
		const configPaths = await expandIncludePath(configFile.root, includePath);
		return Promise.all(configPaths.map(readNornConfigFile));
	}));
	const descendants = await Promise.all(includedConfigFiles.flat().map((includedConfigFile) => loadNornConfigTree(includedConfigFile, visitedPaths)));
	return [configFile, ...descendants.flat()];
}

async function readNornProjectConfigFile(path: string): Promise<NornProjectConfigFile> {
	const config = Value.Parse(nornProjectConfigSchema, Value.Default(nornProjectConfigSchema, JSON.parse(await readFile(path, "utf8"))));
	return { path, root: dirname(path), config };
}

async function readNornConfigFile(path: string): Promise<NornConfigFile> {
	const config = Value.Parse(nornConfigSchema, Value.Default(nornConfigSchema, JSON.parse(await readFile(path, "utf8"))));
	return { path, root: dirname(path), config };
}

function createProjectConfigEntry(projectFile: NornProjectConfigFile): NornConfigFile {
	return {
		path: projectFile.path,
		root: projectFile.root,
		config: {
			plugins: projectFile.config.plugins,
			includes: projectFile.config.includes,
			config: projectFile.config.config,
		},
	};
}

type NornPluginSource = Pick<NornPluginDiagnostic, "configPath" | "pluginPath" | "pluginId">;
type ImportedNornPlugin = { readonly plugin: NornWorkflowPlugin; readonly source: NornPluginSource };

async function collectNornProject(cwd: string): Promise<{ readonly project: NornLoadedProject; readonly diagnostics: NornPluginDiagnostic[] }> {
	const project = await findNornProject(cwd);
	const imported = await importWorkflowPlugins(project);
	const diagnostics = [...imported.diagnostics];
	const registry = new NornWorkflowRegistry();
	const state = new NornMemoryWorkflowState();
	const loaded: LoadedNornWorkflowPlugin[] = [];
	const conflicts = collectPluginConflicts(imported.plugins);
	for (const candidate of imported.plugins) {
		const pluginConflicts = conflicts.get(candidate);
		if (pluginConflicts) {
			diagnostics.push(...pluginConflicts);
			continue;
		}
		const result = registerProjectPlugin({ candidate, project, registry, state });
		diagnostics.push(...result.diagnostics);
		if (result.loaded) loaded.push(result.loaded);
	}
	return {
		project: { ...project, plugins: loaded.map(entry => entry.plugin), pluginInfos: loaded.map(entry => entry.info), registry, workflows: registry.launchableEntries(), state },
		diagnostics,
	};
}

function collectPluginConflicts(plugins: readonly ImportedNornPlugin[]): Map<ImportedNornPlugin, NornPluginDiagnostic[]> {
	const byPluginId = new Map<string, ImportedNornPlugin[]>();
	const byWorkflowId = new Map<string, ImportedNornPlugin[]>();
	for (const candidate of plugins) {
		const id = candidate.plugin.manifest.id;
		byPluginId.set(id, [...(byPluginId.get(id) ?? []), candidate]);
		for (const workflowId of new Set(Object.values(candidate.plugin.manifest.workflows).map(workflow => workflow.id))) {
			byWorkflowId.set(workflowId, [...(byWorkflowId.get(workflowId) ?? []), candidate]);
		}
	}
	const conflicts = new Map<ImportedNornPlugin, NornPluginDiagnostic[]>();
	for (const [pluginId, candidates] of byPluginId) {
		if (candidates.length < 2) continue;
		for (const candidate of candidates) conflicts.set(candidate, [createPluginDiagnostic({
			source: candidate.source, workflowId: null, stage: "duplicate",
			error: new Error(`Duplicate Norn plugin id: ${pluginId} (${candidates.map(other => other.source.pluginPath).join(", ")})`),
		})]);
	}
	for (const [workflowId, candidates] of byWorkflowId) {
		const distinctPlugins = candidates.filter(candidate => byPluginId.get(candidate.plugin.manifest.id)?.length === 1);
		if (distinctPlugins.length < 2) continue;
		for (const candidate of distinctPlugins) conflicts.set(candidate, [...(conflicts.get(candidate) ?? []), createPluginDiagnostic({
			source: candidate.source, workflowId, stage: "duplicate",
			error: new Error(`Workflow already registered: ${workflowId} (${distinctPlugins.map(other => other.source.pluginPath).join(", ")})`),
		})]);
	}
	return conflicts;
}

async function importWorkflowPlugins(project: NornProject): Promise<{ readonly plugins: ImportedNornPlugin[]; readonly diagnostics: NornPluginDiagnostic[] }> {
	const plugins: ImportedNornPlugin[] = [];
	const diagnostics: NornPluginDiagnostic[] = [];
	for (const configFile of project.configFiles) {
		const jiti = createJiti(pathToFileURL(configFile.path).href, { moduleCache: false, virtualModules: nornWorkflowVirtualModules() });
		for (const pluginPath of configFile.config.plugins) {
			const source: NornPluginSource = { configPath: configFile.path, pluginPath: resolveConfigPath(configFile.root, pluginPath), pluginId: null };
			let stage: NornPluginDiagnostic["stage"] = "import";
			try {
				const module = await jiti.import(pathToFileURL(source.pluginPath).href) as { default?: unknown };
				stage = "declaration";
				if (!isWorkflowPlugin(module?.default)) throw new Error(`Norn plugin must be the default export: ${source.pluginPath}`);
				plugins.push({ plugin: module.default, source: { ...source, pluginId: module.default.manifest.id } });
			} catch (error) {
				diagnostics.push(createPluginDiagnostic({ source, workflowId: null, stage, error }));
			}
		}
	}
	return { plugins, diagnostics };
}

function registerProjectPlugin(input: {
	readonly candidate: ImportedNornPlugin;
	readonly project: NornProject;
	readonly registry: NornWorkflowRegistry;
	readonly state: NornMemoryWorkflowState;
}): { readonly loaded: LoadedNornWorkflowPlugin | null; readonly diagnostics: NornPluginDiagnostic[] } {
	const { plugin, source } = input.candidate;
	const diagnostics: NornPluginDiagnostic[] = [];
	const unregister: NornDispose[] = [];
	let stage: NornPluginDiagnostic["stage"] = "config";
	try {
		const configInput = input.project.projectConfig[plugin.manifest.id];
		const configuration = decodePluginConfiguration({ pluginId: plugin.manifest.id, schema: plugin.manifest.config, value: configInput });
		stage = "schema";
		const info: NornProjectPluginInfo = {
			id: plugin.manifest.id, path: source.pluginPath, configPath: source.configPath,
			configSchema: plugin.manifest.config ? inspectSchema(plugin.manifest.config) : null, config: configuration?.value,
		};
		stage = "implementation";
		const implementation = typeof plugin.implementation === "function" ? plugin.implementation({ cwd: input.project.cwd, state: input.state }) : plugin.implementation;
		for (const [key, workflow] of Object.entries(plugin.manifest.workflows)) {
			stage = "implementation";
			try {
				const workflowImplementation = implementation.workflows?.[key];
				if (typeof workflowImplementation?.execute !== "function") throw new Error(`Missing implementation for workflow ${workflow.id}`);
				stage = "duplicate";
				if (input.registry.workflowById(workflow.id)) throw new Error(`Workflow already registered: ${workflow.id}`);
				stage = "declaration";
				unregister.push(input.registry.register(workflow, workflowImplementation, { plugin: workflowPluginInfo(info), configuration }));
			} catch (error) {
				diagnostics.push(createPluginDiagnostic({ source, workflowId: workflow.id, stage, error }));
			}
		}
		if (diagnostics.length === 0) return { loaded: { plugin, info }, diagnostics };
	} catch (error) {
		diagnostics.push(createPluginDiagnostic({ source, workflowId: null, stage, error }));
	}
	for (const dispose of unregister) dispose();
	return { loaded: null, diagnostics };
}

function createPluginDiagnostic(input: {
	readonly source: NornPluginSource;
	readonly workflowId: string | null;
	readonly stage: NornPluginDiagnostic["stage"];
	readonly error: unknown;
}): NornPluginDiagnostic {
	return {
		...input.source, workflowId: input.workflowId, stage: input.stage, message: errorMessage(input.error),
		issues: input.error instanceof AssertError ? input.error.cause.errors : [],
	};
}

function workflowPluginInfo(info: NornProjectPluginInfo): NornWorkflowPluginInfo {
	return { id: info.id, path: info.path, configPath: info.configPath };
}

function nornWorkflowVirtualModules(): Record<string, unknown> {
	return {
		"@vimhead.dev/norn": nornModule,
		"@vimhead.dev/norn/files": nornFilesModule,
		"@vimhead.dev/norn/schema": nornSchemaModule,
		"@vimhead.dev/norn/seer": nornSeerModule,
		typebox: typeboxModule,
		"typebox/value": typeboxValueModule,
		"typebox/compile": typeboxCompileModule,
		"typebox/schema": typeboxSchemaModule,
	};
}

function mergeProjectConfig(configFiles: readonly NornConfigFile[]): Record<string, unknown> {
	const [projectFile, ...reusableConfigFiles] = configFiles;
	let reusableConfig: Record<string, unknown> = {};
	for (const configFile of reusableConfigFiles) {
		reusableConfig = mergeReusableConfigObjects(reusableConfig, configFile.config.config, ["config"]);
	}
	return mergeProjectConfigObjects(reusableConfig, projectFile?.config.config ?? {});
}

function mergeReusableConfigObjects(base: Record<string, unknown>, override: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, overrideValue] of Object.entries(override)) {
		result[key] = Object.prototype.hasOwnProperty.call(result, key)
			? mergeReusableConfigValue(result[key], overrideValue, [...path, key])
			: overrideValue;
	}
	return result;
}

function mergeReusableConfigValue(base: unknown, override: unknown, path: readonly string[]): unknown {
	if (isPlainObject(base) && isPlainObject(override)) return mergeReusableConfigObjects(base, override, path);
	if (JSON.stringify(base) === JSON.stringify(override)) return base;
	throw new Error(`Conflicting Norn reusable config at ${path.join(".")}`);
}

function mergeProjectConfigObjects(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, overrideValue] of Object.entries(override)) {
		result[key] = isPlainObject(result[key]) && isPlainObject(overrideValue)
			? mergeProjectConfigObjects(result[key], overrideValue)
			: overrideValue;
	}
	return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function expandIncludePath(configRoot: string, includePath: string): Promise<string[]> {
	const resolvedIncludePath = resolveConfigPath(configRoot, includePath);
	if (!hasGlobSegment(includePath)) return [resolvedIncludePath];
	return expandGlobSegments(isAbsolute(includePath) ? sep : configRoot, splitPathSegments(includePath));
}

async function expandGlobSegments(root: string, segments: readonly string[]): Promise<string[]> {
	if (segments.length === 0) return [root];
	const [segment, ...remainingSegments] = segments;
	if (segment === "*") {
		const entries = await readdir(root, { withFileTypes: true });
		const expanded = await Promise.all(entries
			.filter((entry) => entry.isDirectory())
			.sort((left, right) => left.name.localeCompare(right.name))
			.map((entry) => expandGlobSegments(join(root, entry.name), remainingSegments)));
		return expanded.flat();
	}
	return expandGlobSegments(join(root, segment), remainingSegments);
}

function resolveConfigPath(configRoot: string, path: string): string {
	if (path.length === 0) throw new Error("Norn path must not be empty");
	return isAbsolute(path) ? path : resolve(configRoot, path);
}

function hasGlobSegment(path: string): boolean {
	return splitPathSegments(path).includes("*");
}

function splitPathSegments(path: string): string[] {
	return path.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
}

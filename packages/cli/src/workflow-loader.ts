import * as nornModule from "@vimhead.dev/norn";
import { isWorkflowDeclaration, type NornAnyWorkflowDeclaration, type NornDispose, type NornWorkflowDiagnostic, type NornProjectInfo, type NornProjectInspection, type NornProjectConfigurationInfo, type NornWorkflowCatalogInfo, type NornWorkflowInspection, type NornWorkflowSource } from "@vimhead.dev/norn";
import { isNodeError } from "@vimhead.dev/norn-core/errors";
import * as nornFilesModule from "@vimhead.dev/norn/files";
import * as nornSchemaModule from "@vimhead.dev/norn/schema";
import { inspectSchema, isPlainObject } from "@vimhead.dev/norn/schema";
import { createJiti, type ModuleCache } from "jiti/static";
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
import { assertCompatibleConfigurationOwners, assertWorkflowDefinition, NornWorkflowRegistry, type NornRegisteredWorkflow } from "./internal/workflow-registry.ts";

export const NORN_PROJECT_FILE_NAME = "norn.project.json";
const nornConfigSchema = Type.Object({
	workflows: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
	includes: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
	config: Type.Record(Type.String(), Type.Unknown(), { default: {} }),
});
const nornProjectConfigSchema = Type.Object({ ...nornConfigSchema.properties, version: Type.Literal(1, { default: 1 }) });
type NornConfig = StaticDecode<typeof nornConfigSchema>;
type NornProjectConfig = StaticDecode<typeof nornProjectConfigSchema>;
type NornConfigFile = { readonly path: string; readonly root: string; readonly config: NornConfig };
type NornProjectConfigFile = Omit<NornConfigFile, "config"> & { readonly config: NornProjectConfig };
export type NornProject = {
	readonly cwd: string; readonly projectPath: string; readonly projectRoot: string;
	readonly configPath: string; readonly configRoot: string; readonly config: NornProjectConfig;
	readonly configFiles: readonly NornConfigFile[]; readonly projectConfig: Record<string, unknown>;
};
export type NornLoadedProject = NornProject & {
	readonly definitions: readonly NornAnyWorkflowDeclaration[];
	readonly modules: readonly NornWorkflowSource[];
	readonly configurations: readonly NornProjectConfigurationInfo[];
	readonly registry: NornWorkflowRegistry;
	readonly workflows: readonly NornRegisteredWorkflow[];
};
type ImportedWorkflowModule = { readonly definitions: readonly NornAnyWorkflowDeclaration[]; readonly source: NornWorkflowSource };

export async function loadNornProject(cwd: string): Promise<NornLoadedProject> {
	const { project, diagnostics } = await collectNornProject(cwd);
	if (diagnostics.length) throw new NornProjectLoadError({ diagnostics });
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
		if (!diagnostics.length) throw new Error(`Unknown workflow: ${input.workflowId}`);
		return { workflow: null, isComplete: false, diagnostics };
	}
	try { return { workflow: project.registry.inspect(input.workflowId) ?? null, isComplete: diagnostics.length === 0, diagnostics }; }
	catch (error) {
		if (!summary.source) throw error;
		return { workflow: null, isComplete: false, diagnostics: [...diagnostics, createDiagnostic({ source: summary.source, workflowId: summary.id, scopeId: summary.scope?.id ?? null, stage: "schema", error })] };
	}
}
function buildProjectInfo(project: NornLoadedProject): NornProjectInfo {
	return {
		cwd: project.cwd, projectPath: project.projectPath, projectRoot: project.projectRoot,
		configPath: project.configPath, configRoot: project.configRoot, configFiles: project.configFiles.map(file => file.path),
		modules: project.modules, configurations: project.configurations,
	};
}
export async function findNornProject(cwd: string): Promise<NornProject> {
	const projectPath = await findNearestNornProject(cwd);
	const projectFile = await readConfigFile({ path: projectPath, isProject: true });
	const configFiles = await loadConfigTree(projectFile, new Set());
	return {
		cwd: resolve(cwd), projectPath, projectRoot: projectFile.root, configPath: projectPath, configRoot: projectFile.root,
		config: projectFile.config, configFiles, projectConfig: mergeProjectConfig(configFiles),
	};
}
async function findNearestNornProject(cwd: string): Promise<string> {
	let current = resolve(cwd);
	while (true) {
		const path = join(current, NORN_PROJECT_FILE_NAME);
		try { await access(path); return path; }
		catch (error) { if (!isNodeError(error) || error.code !== "ENOENT") throw error; }
		const parent = dirname(current);
		if (parent === current) throw new Error(`Could not find ${NORN_PROJECT_FILE_NAME} from ${cwd}`);
		current = parent;
	}
}
async function loadConfigTree(file: NornConfigFile, visited: Set<string>): Promise<NornConfigFile[]> {
	if (visited.has(file.path)) return [];
	visited.add(file.path);
	const files: NornConfigFile[] = [file];
	for (const include of file.config.includes) {
		for (const path of await expandIncludePath(file.root, include)) files.push(...await loadConfigTree(await readConfigFile({ path, isProject: false }), visited));
	}
	return files;
}
async function readConfigFile(input: { readonly path: string; readonly isProject: boolean }): Promise<NornProjectConfigFile> {
	const raw: unknown = JSON.parse(await readFile(input.path, "utf8"));
	if (isPlainObject(raw) && Object.hasOwn(raw, "plugins")) throw new Error(`Replace plugins with workflows in ${input.path}; registration modules must export workflow arrays`);
	const schema = input.isProject ? nornProjectConfigSchema : nornConfigSchema;
	const config = Value.Parse(schema, Value.Default(schema, raw));
	return { path: input.path, root: dirname(input.path), config: { ...config, version: 1 } };
}
async function collectNornProject(cwd: string): Promise<{ readonly project: NornLoadedProject; readonly diagnostics: NornWorkflowDiagnostic[] }> {
	const project = await findNornProject(cwd);
	const imported = await importWorkflowModules(project);
	const diagnostics = [...imported.diagnostics];
	const registry = new NornWorkflowRegistry();
	const loaded: ImportedWorkflowModule[] = [];
	const conflicts = collectModuleConflicts(imported.modules);
	for (const candidate of imported.modules) {
		const conflict = conflicts.get(candidate);
		if (conflict) { diagnostics.push(...conflict); continue; }
		const unregister: NornDispose[] = [];
		const errors: NornWorkflowDiagnostic[] = [];
		for (const workflow of candidate.definitions) {
			let stage: NornWorkflowDiagnostic["stage"] = "schema";
			try {
				if (workflow.config) inspectSchema(workflow.config);
				if (workflow.scope?.config) inspectSchema(workflow.scope.config);
				stage = "declaration";
				assertWorkflowDefinition(workflow);
				stage = "config";
				unregister.push(registry.register({ workflow, config: project.projectConfig, source: candidate.source }));
			} catch (error) { errors.push(createDiagnostic({ source: candidate.source, workflowId: workflow.id, scopeId: workflow.scope?.id ?? null, stage, error })); }
		}
		if (errors.length) { for (const dispose of unregister) dispose(); diagnostics.push(...errors); }
		else loaded.push(candidate);
	}
	const definitions = loaded.flatMap(module => module.definitions);
	return { project: { ...project, definitions, modules: loaded.map(module => module.source), configurations: registry.configurationInfos(), registry, workflows: registry.launchableEntries() }, diagnostics };
}
function collectModuleConflicts(modules: readonly ImportedWorkflowModule[]): Map<ImportedWorkflowModule, NornWorkflowDiagnostic[]> {
	const conflicts = new Map<ImportedWorkflowModule, NornWorkflowDiagnostic[]>();
	const byId = new Map<string, ImportedWorkflowModule[]>();
	for (const module of modules) for (const workflow of module.definitions) byId.set(workflow.id, [...byId.get(workflow.id) ?? [], module]);
	for (const [id, owners] of byId) {
		if (owners.length < 2) continue;
		for (const module of new Set(owners)) conflicts.set(module, [...conflicts.get(module) ?? [], createDiagnostic({ source: module.source, workflowId: id, scopeId: null, stage: "duplicate", error: new Error(`Workflow already registered: ${id}`) })]);
	}
	for (let index = 0; index < modules.length; index++) {
		for (let other = index; other < modules.length; other++) {
			const candidates = [...new Set([modules[index], modules[other]])];
			try { assertCompatibleConfigurationOwners(candidates.flatMap(module => module.definitions)); }
			catch (error) { for (const module of candidates) conflicts.set(module, [...conflicts.get(module) ?? [], createDiagnostic({ source: module.source, workflowId: null, scopeId: null, stage: "config", error })]); }
		}
	}
	return conflicts;
}
async function importWorkflowModules(project: NornProject): Promise<{ readonly modules: ImportedWorkflowModule[]; readonly diagnostics: NornWorkflowDiagnostic[] }> {
	const modules: ImportedWorkflowModule[] = [];
	const diagnostics: NornWorkflowDiagnostic[] = [];
	const jiti = createJiti(pathToFileURL(project.configPath).href, { moduleCache: false, tryNative: false, virtualModules: nornWorkflowVirtualModules() });
	const cache: ModuleCache = Object.create(null);
	for (const file of project.configFiles) for (const path of file.config.workflows) {
		const source = { configPath: file.path, path: resolveConfigPath(file.root, path) };
		let stage: NornWorkflowDiagnostic["stage"] = "import";
		try {
			const cached = cache[source.path];
			const module = (cached?.loaded ? cached.exports : await jiti.evalModule(await readFile(source.path, "utf8"), { filename: source.path, cache, async: true })) as { default?: unknown };
			stage = "declaration";
			if (!Array.isArray(module?.default) || !Array.from(module.default).every(isWorkflowDeclaration)) throw new Error(`Workflow module must default-export an array of complete workflow definitions: ${source.path}`);
			modules.push({ definitions: module.default, source });
		} catch (error) {
			for (const [path, module] of Object.entries(cache)) if (!module.loaded) delete cache[path];
			diagnostics.push(createDiagnostic({ source, workflowId: null, scopeId: null, stage, error }));
		}
	}
	return { modules, diagnostics };
}
function createDiagnostic(input: { readonly source: NornWorkflowSource; readonly workflowId: string | null; readonly scopeId: string | null; readonly stage: NornWorkflowDiagnostic["stage"]; readonly error: unknown }): NornWorkflowDiagnostic {
	return { configPath: input.source.configPath, modulePath: input.source.path, scopeId: input.scopeId, workflowId: input.workflowId, stage: input.stage, message: errorMessage(input.error), issues: input.error instanceof AssertError ? input.error.cause.errors : [] };
}
function nornWorkflowVirtualModules(): Record<string, unknown> {
	return { "@vimhead.dev/norn": nornModule, "@vimhead.dev/norn/files": nornFilesModule, "@vimhead.dev/norn/schema": nornSchemaModule, typebox: typeboxModule, "typebox/value": typeboxValueModule, "typebox/compile": typeboxCompileModule, "typebox/schema": typeboxSchemaModule };
}
function mergeProjectConfig(files: readonly NornConfigFile[]): Record<string, unknown> {
	const [project, ...reusable] = files;
	let config: Record<string, unknown> = {};
	for (const file of reusable) config = mergeConfig({ base: config, override: file.config.config, path: ["config"], rejectConflicts: true });
	return mergeConfig({ base: config, override: project?.config.config ?? {}, path: ["config"], rejectConflicts: false });
}
function mergeConfig(input: { readonly base: Record<string, unknown>; readonly override: Record<string, unknown>; readonly path: readonly string[]; readonly rejectConflicts: boolean }): Record<string, unknown> {
	const result = { ...input.base };
	for (const [key, value] of Object.entries(input.override)) {
		const previous = result[key];
		const path = [...input.path, key];
		if (isPlainObject(previous) && isPlainObject(value)) result[key] = mergeConfig({ base: previous, override: value, path, rejectConflicts: input.rejectConflicts });
		else if (input.rejectConflicts && Object.hasOwn(result, key) && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error(`Conflicting Norn reusable config at ${path.join(".")}`);
		else result[key] = value;
	}
	return result;
}
async function expandIncludePath(root: string, path: string): Promise<string[]> {
	const segments = path.split(/[\\/]+/).filter(segment => segment.length && segment !== ".");
	return segments.includes("*") ? expandGlobSegments(isAbsolute(path) ? sep : root, segments) : [resolveConfigPath(root, path)];
}
async function expandGlobSegments(root: string, segments: readonly string[]): Promise<string[]> {
	if (!segments.length) return [root];
	const [segment, ...remaining] = segments;
	if (segment !== "*") return expandGlobSegments(join(root, segment), remaining);
	const entries = await readdir(root, { withFileTypes: true });
	return (await Promise.all(entries.filter(entry => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name)).map(entry => expandGlobSegments(join(root, entry.name), remaining)))).flat();
}
function resolveConfigPath(root: string, path: string): string {
	if (!path.length) throw new Error("Norn path must not be empty");
	return isAbsolute(path) ? path : resolve(root, path);
}

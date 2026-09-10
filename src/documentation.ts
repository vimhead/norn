import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { NornBuildInfo } from "./build-info.ts";
import { DOCUMENTATION_PATHS, hashDocumentationBundle, validateDocumentationBundle, type NornDocumentationBundle } from "./internal/documentation-bundle.ts";
import { isNodeError } from "./internal/errors.ts";

export { renderNornDocumentationIntro } from "./documentation-intro.ts";

export type NornDocumentationSource =
	| { readonly kind: "local"; readonly root: string }
	| { readonly kind: "embedded"; readonly bundle: NornDocumentationBundle };

export type NornDocumentationLocation = {
	readonly storage: "installation" | "cache";
	readonly version: string;
	readonly commit: string | null;
	readonly assetDigest: string | null;
	readonly paths: { readonly root: string; readonly readme: string; readonly index: string; readonly docs: string; readonly examples: string; readonly skill: string };
};

export function resolveDocumentationCacheRoot(input: {
	readonly platform: string;
	readonly home: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
}): string {
	const override = input.environment.NORN_DOCS_CACHE_DIR;
	if (override) return resolve(override);
	if (input.platform === "win32") return join(input.environment.LOCALAPPDATA || join(input.home, "AppData", "Local"), "norn", "docs");
	if (input.platform === "darwin") return join(input.home, "Library", "Caches", "norn", "docs");
	const xdgCache = input.environment.XDG_CACHE_HOME;
	return join(xdgCache?.startsWith("/") ? xdgCache : join(input.home, ".cache"), "norn", "docs");
}

export async function resolveNornDocumentation(input: {
	readonly source: NornDocumentationSource;
	readonly build: NornBuildInfo;
	readonly cacheRoot: string;
}): Promise<NornDocumentationLocation> {
	let root: string;
	let version: string;
	let assetDigest: string | null = null;
	if (input.source.kind === "local") {
		root = resolve(input.source.root);
		const packageInfo = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: unknown };
		if (typeof packageInfo.version !== "string" || packageInfo.version.length === 0) throw new Error("Invalid documentation package version");
		version = packageInfo.version;
		await validateLocalDocumentation(root);
	} else {
		validateDocumentationBundle(input.source.bundle);
		version = input.source.bundle.version;
		if (version !== input.build.version) throw new Error("Embedded documentation version does not match the binary build");
		assetDigest = hashDocumentationBundle(input.source.bundle);
		const cacheKey = createHash("sha256").update(JSON.stringify({ format: 1, assetDigest, version, commit: input.build.commit })).digest("hex");
		root = await new NornDocumentationCache({ cacheRoot: resolve(input.cacheRoot), cacheKey, bundle: input.source.bundle }).materialize();
	}
	return {
		storage: input.source.kind === "local" ? "installation" : "cache",
		version,
		commit: input.build.commit,
		assetDigest,
		paths: {
			root,
			readme: join(root, DOCUMENTATION_PATHS.readme),
			index: join(root, DOCUMENTATION_PATHS.index),
			docs: join(root, DOCUMENTATION_PATHS.docs),
			examples: join(root, DOCUMENTATION_PATHS.examples),
			skill: join(root, DOCUMENTATION_PATHS.skill),
		},
	};
}

async function validateLocalDocumentation(root: string): Promise<void> {
	for (const [key, path] of Object.entries(DOCUMENTATION_PATHS)) {
		const stat = await lstat(join(root, path));
		const isExpectedType = key === "docs" || key === "examples" ? stat.isDirectory() : stat.isFile();
		if (!isExpectedType) throw new Error(`Invalid local documentation path: ${join(root, path)}`);
	}
}

class NornDocumentationCache {
	private readonly root: string;
	private readonly files: ReadonlyMap<string, string>;

	constructor(private readonly input: { readonly cacheRoot: string; readonly cacheKey: string; readonly bundle: NornDocumentationBundle }) {
		this.root = join(input.cacheRoot, `v1-${input.cacheKey}`);
		this.files = new Map(input.bundle.files.map(file => [file.path, file.content]));
	}

	async materialize(): Promise<string> {
		await mkdir(this.input.cacheRoot, { recursive: true, mode: 0o700 });
		const cacheStat = await lstat(this.input.cacheRoot);
		if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink()) throw new Error(`Documentation cache root must be a real directory: ${this.input.cacheRoot}`);
		if (await this.validateExistingCache()) return this.root;
		const staging = await mkdtemp(join(this.input.cacheRoot, ".extract-"));
		try {
			for (const file of this.input.bundle.files) {
				const parts = file.path.split("/");
				await mkdir(join(staging, ...parts.slice(0, -1)), { recursive: true, mode: 0o700 });
				await writeFile(join(staging, ...parts), file.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
			}
			try {
				await rename(staging, this.root);
			} catch (error) {
				if (!isNodeError(error) || !["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code ?? "")) throw error;
				if (!await this.validateExistingCache()) throw error;
			}
			if (!await this.validateExistingCache()) throw new Error(`Documentation cache disappeared after extraction: ${this.root}`);
			return this.root;
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	}

	private async validateExistingCache(): Promise<boolean> {
		let stat;
		try {
			stat = await lstat(this.root);
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return false;
			throw error;
		}
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw this.invalidCacheError();
		const seenFiles = new Set<string>();
		await this.validateDirectory({ directory: this.root, prefix: "", seenFiles });
		if (seenFiles.size !== this.files.size) throw this.invalidCacheError();
		return true;
	}

	private async validateDirectory(input: { readonly directory: string; readonly prefix: string; readonly seenFiles: Set<string> }): Promise<void> {
		for (const entry of await readdir(input.directory, { withFileTypes: true })) {
			const path = input.prefix ? `${input.prefix}/${entry.name}` : entry.name;
			const absolutePath = join(input.directory, entry.name);
			if (entry.isDirectory()) {
				if (![...this.files.keys()].some(file => file.startsWith(`${path}/`))) throw this.invalidCacheError();
				await this.validateDirectory({ directory: absolutePath, prefix: path, seenFiles: input.seenFiles });
			} else if (entry.isFile() && this.files.has(path)) {
				if (!(await readFile(absolutePath)).equals(Buffer.from(this.files.get(path)!, "utf8"))) throw this.invalidCacheError();
				input.seenFiles.add(path);
			} else {
				throw this.invalidCacheError();
			}
		}
	}

	private invalidCacheError(): Error {
		return new Error(`Documentation cache is incomplete or modified: ${this.root}. Remove this cache entry and retry; copy examples elsewhere before editing them.`);
	}
}

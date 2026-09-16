import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { isNodeError } from "./errors.ts";

export type PiAssetFile = { readonly path: string; readonly content: string };

export function resolvePiAssetsCacheRoot(input: {
	readonly platform: string;
	readonly home: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
}): string {
	if (input.environment.NORN_PI_CACHE_DIR) return resolve(input.environment.NORN_PI_CACHE_DIR);
	if (input.platform === "darwin") return join(input.home, "Library", "Caches", "norn", "pi");
	if (input.platform === "win32") return join(input.environment.LOCALAPPDATA || join(input.home, "AppData", "Local"), "norn", "pi");
	const xdgCache = input.environment.XDG_CACHE_HOME;
	return join(xdgCache?.startsWith("/") ? xdgCache : join(input.home, ".cache"), "norn", "pi");
}

export async function materializePiAssets(input: { readonly archive: string; readonly cacheRoot: string }): Promise<string> {
	const digest = createHash("sha256").update(input.archive).digest("hex");
	const files: PiAssetFile[] = JSON.parse(gunzipSync(Buffer.from(input.archive, "base64")).toString("utf8"));
	const expectedFiles = new Map<string, Buffer>();
	for (const file of files) {
		if (!file.path || file.path.includes("\\") || file.path.includes(":") || file.path.split("/").some(part => !part || part === "." || part === "..") || expectedFiles.has(file.path)) {
			throw new Error("Invalid bundled Pi asset path");
		}
		expectedFiles.set(file.path, Buffer.from(file.content, "base64"));
	}
	return new PiAssetCache({ cacheRoot: input.cacheRoot, digest, expectedFiles }).materialize();
}

class PiAssetCache {
	private readonly root: string;

	constructor(private readonly input: { readonly cacheRoot: string; readonly digest: string; readonly expectedFiles: ReadonlyMap<string, Buffer> }) {
		this.root = join(input.cacheRoot, `v1-${input.digest}`);
	}

	async materialize(): Promise<string> {
		await mkdir(this.input.cacheRoot, { recursive: true, mode: 0o700 });
		if (!(await lstat(this.input.cacheRoot)).isDirectory()) throw new Error("Pi asset cache root must be a real directory");
		if (await this.validateExistingCache()) return this.root;
		const staging = await mkdtemp(join(this.input.cacheRoot, ".extract-"));
		try {
			for (const [path, content] of this.input.expectedFiles) {
				const parts = path.split("/");
				await mkdir(join(staging, ...parts.slice(0, -1)), { recursive: true, mode: 0o700 });
				await writeFile(join(staging, ...parts), content, { flag: "wx", mode: 0o600 });
			}
			try {
				await rename(staging, this.root);
			} catch (error) {
				if (!isNodeError(error) || !["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code ?? "") || !await this.validateExistingCache()) throw error;
			}
			if (!await this.validateExistingCache()) throw new Error("Pi assets disappeared after extraction");
			return this.root;
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	}

	private async validateExistingCache(): Promise<boolean> {
		try {
			if (!(await lstat(this.root)).isDirectory()) throw this.invalidCacheError();
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return false;
			throw error;
		}
		const seen = new Set<string>();
		await this.validateDirectory({ directory: this.root, prefix: "", seen });
		if (seen.size !== this.input.expectedFiles.size) throw this.invalidCacheError();
		return true;
	}

	private async validateDirectory(input: { readonly directory: string; readonly prefix: string; readonly seen: Set<string> }): Promise<void> {
		for (const entry of await readdir(input.directory, { withFileTypes: true })) {
			const path = input.prefix ? `${input.prefix}/${entry.name}` : entry.name;
			const absolutePath = join(input.directory, entry.name);
			if (entry.isDirectory()) {
				if (![...this.input.expectedFiles.keys()].some(file => file.startsWith(`${path}/`))) throw this.invalidCacheError();
				await this.validateDirectory({ directory: absolutePath, prefix: path, seen: input.seen });
			} else {
				const expected = this.input.expectedFiles.get(path);
				if (!entry.isFile() || !expected || !(await readFile(absolutePath)).equals(expected)) throw this.invalidCacheError();
				input.seen.add(path);
			}
		}
	}

	private invalidCacheError(): Error {
		return new Error(`Bundled Pi assets are incomplete or modified: ${this.root}. Remove this cache entry and retry.`);
	}
}

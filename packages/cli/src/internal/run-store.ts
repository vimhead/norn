import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	access,
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	readlink,
	rename,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { NornRunCheckpoint } from "@vimhead.dev/norn";
import { isNodeError } from "@vimhead.dev/norn-core/errors";
import {
	writeJsonAtomically,
	writeTextAtomically,
} from "@vimhead.dev/norn-core/atomic-files";

const gzipBuffer = promisify(gzip);
const gunzipBuffer = promisify(gunzip);
const SNAPSHOT_VERSION = 1;
const CURRENT_DIR_NAME = "current";
const STORE_DIR_NAME = "store";
const CHECKPOINTS_FILE_NAME = "checkpoints.json";

export function runCurrentRoot(runRoot: string): string {
	return join(runRoot, CURRENT_DIR_NAME);
}

export class NornRunStore {
	private readonly currentRoot: string;
	private readonly storeRoot: string;

	private constructor(private readonly runRoot: string) {
		this.currentRoot = runCurrentRoot(runRoot);
		this.storeRoot = join(runRoot, STORE_DIR_NAME);
	}

	static async initialize(root: string): Promise<NornRunStore> {
		const runStore = new NornRunStore(root);
		await mkdir(runStore.currentRoot, { recursive: true });
		await mkdir(runStore.objectsRoot, { recursive: true });
		await mkdir(runStore.snapshotsRoot, { recursive: true });
		await mkdir(runStore.refsRoot, { recursive: true });
		return runStore;
	}

	static async open(root: string): Promise<NornRunStore> {
		const runStore = new NornRunStore(root);
		await access(runStore.currentRoot, constants.R_OK | constants.W_OK);
		await access(runStore.storeRoot, constants.R_OK | constants.W_OK);
		return runStore;
	}

	async currentSnapshotRef(): Promise<string> {
		return readFile(this.currentRefPath, "utf8").then((value) => value.trim());
	}

	async snapshotCurrent(message: string): Promise<NornRunCheckpoint> {
		const previous = await this.readCheckpointHistory();
		const checkpoint = this.createCheckpoint(
			message,
			previous.checkpoints.length + 1,
		);
		const checkpoints = [...previous.checkpoints, checkpoint];
		await this.createSnapshot(checkpoint, checkpoints);
		await writeJsonAtomically(this.checkpointsPath, checkpoints);
		try {
			await writeTextAtomically(this.currentRefPath, `${checkpoint.id}\n`);
		} catch (error) {
			if (previous.content === undefined)
				await rm(this.checkpointsPath, { force: true });
			else await writeTextAtomically(this.checkpointsPath, previous.content);
			throw error;
		}
		return checkpoint;
	}

	async restoreSnapshot(
		ref: string,
		prepare: ((stagedRunRoot: string) => Promise<void>) | undefined,
	): Promise<void> {
		const checkpoint = (await this.listCheckpoints()).find(
			(entry) => entry.id === ref,
		);
		if (!checkpoint) throw new Error(`Unknown active run checkpoint: ${ref}`);
		await this.restoreSnapshotManifest(
			await this.readSnapshot(checkpoint.id),
			prepare,
		);
	}

	async restoreCurrentSnapshot(): Promise<void> {
		await this.restoreSnapshotManifest(
			await this.readSnapshot(await this.currentSnapshotRef()),
			undefined,
		);
	}

	async listCheckpoints(): Promise<NornRunCheckpoint[]> {
		return (await this.readCheckpointHistory()).checkpoints;
	}

	private async readCheckpointHistory(): Promise<{
		readonly checkpoints: NornRunCheckpoint[];
		readonly content?: string;
	}> {
		try {
			const content = await readFile(this.checkpointsPath, "utf8");
			const checkpoints = parseNornRunCheckpoints(JSON.parse(content));
			for (const checkpoint of checkpoints)
				this.assertCheckpointPathMatchesId(checkpoint);
			return { checkpoints, content };
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT")
				return { checkpoints: [] };
			throw error;
		}
	}

	async assertWorkspaceCanBeSnapshotted(_workspace: string): Promise<void> {}

	private get objectsRoot(): string {
		return join(this.storeRoot, "objects", "sha256");
	}

	private get snapshotsRoot(): string {
		return join(this.storeRoot, "snapshots");
	}

	private get refsRoot(): string {
		return join(this.storeRoot, "refs");
	}

	private get currentRefPath(): string {
		return join(this.refsRoot, "current");
	}

	private get checkpointsPath(): string {
		return join(this.currentRoot, CHECKPOINTS_FILE_NAME);
	}

	private createCheckpoint(message: string, index: number): NornRunCheckpoint {
		const id = `cp_${randomUUID().replaceAll("-", "")}`;
		return {
			id,
			path: this.snapshotRelativePath(id),
			index,
			message,
			createdAt: new Date().toISOString(),
		};
	}

	private async createSnapshot(
		checkpoint: NornRunCheckpoint,
		checkpoints: readonly NornRunCheckpoint[],
	): Promise<RunSnapshotManifest> {
		const entries = (await this.snapshotEntries(this.currentRoot)).filter(
			(entry) => entry.path !== CHECKPOINTS_FILE_NAME,
		);
		const historyBytes = Buffer.from(
			`${JSON.stringify(checkpoints, null, 2)}\n`,
		);
		const historyHash = hashBuffer(historyBytes);
		await this.storeObject(historyHash, historyBytes);
		entries.push({
			path: CHECKPOINTS_FILE_NAME,
			type: "file",
			sha256: historyHash,
			size: historyBytes.length,
			mode: 0o600,
			mtimeMs: Date.now(),
			compression: "gzip",
		});
		entries.sort((left, right) => left.path.localeCompare(right.path));
		const snapshot: RunSnapshotManifest = {
			version: SNAPSHOT_VERSION,
			id: checkpoint.id,
			path: checkpoint.path,
			index: checkpoint.index,
			message: checkpoint.message,
			createdAt: checkpoint.createdAt,
			entries,
		};
		await writeJsonAtomically(this.snapshotPath(snapshot.id), snapshot);
		return snapshot;
	}

	private async snapshotEntries(root: string): Promise<RunSnapshotEntry[]> {
		const entries: RunSnapshotEntry[] = [];
		await this.collectSnapshotEntries(root, "", entries);
		return entries.sort((left, right) => left.path.localeCompare(right.path));
	}

	private async collectSnapshotEntries(
		absolutePath: string,
		snapshotPath: string,
		entries: RunSnapshotEntry[],
	): Promise<void> {
		const stat = await lstat(absolutePath);
		if (stat.isDirectory()) {
			if (snapshotPath.length > 0)
				entries.push({
					path: snapshotPath,
					type: "directory",
					mode: stat.mode,
				});
			const children = await readdir(absolutePath, { withFileTypes: true });
			for (const child of children.sort((left, right) =>
				left.name.localeCompare(right.name),
			)) {
				await this.collectSnapshotEntries(
					join(absolutePath, child.name),
					joinSnapshotPath(snapshotPath, child.name),
					entries,
				);
			}
			return;
		}
		if (stat.isSymbolicLink()) {
			entries.push({
				path: snapshotPath,
				type: "symlink",
				target: await readlink(absolutePath),
			});
			return;
		}
		if (!stat.isFile()) return;
		const bytes = await readFile(absolutePath);
		const sha256 = hashBuffer(bytes);
		await this.storeObject(sha256, bytes);
		entries.push({
			path: snapshotPath,
			type: "file",
			sha256,
			size: stat.size,
			mode: stat.mode,
			mtimeMs: stat.mtimeMs,
			compression: "gzip",
		});
	}

	private async storeObject(sha256: string, bytes: Buffer): Promise<void> {
		const path = this.objectPath(sha256);
		try {
			await access(path, constants.R_OK);
			return;
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		}
		await mkdir(dirname(path), { recursive: true });
		const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(tmpPath, await gzipBuffer(bytes));
		await rename(tmpPath, path);
	}

	private async restoreSnapshotManifest(
		snapshot: RunSnapshotManifest,
		prepare: ((stagedRunRoot: string) => Promise<void>) | undefined,
	): Promise<void> {
		const stagedRunRoot = await mkdtemp(join(this.runRoot, ".restore-"));
		const stagedCurrent = runCurrentRoot(stagedRunRoot);
		const previousCurrent = join(this.runRoot, `.previous-${randomUUID()}`);
		try {
			await mkdir(stagedCurrent);
			await this.materializeSnapshot(snapshot, stagedCurrent);
			await prepare?.(stagedRunRoot);
			await rename(this.currentRoot, previousCurrent);
			try {
				await rename(stagedCurrent, this.currentRoot);
			} catch (error) {
				await rename(previousCurrent, this.currentRoot);
				throw error;
			}
			try {
				await writeTextAtomically(this.currentRefPath, `${snapshot.id}\n`);
			} catch (error) {
				await rename(this.currentRoot, stagedCurrent);
				await rename(previousCurrent, this.currentRoot);
				throw error;
			}
			await rm(previousCurrent, { recursive: true, force: true }).catch(
				() => undefined,
			);
		} finally {
			await rm(stagedRunRoot, { recursive: true, force: true }).catch(
				() => undefined,
			);
		}
	}

	private async materializeSnapshot(
		snapshot: RunSnapshotManifest,
		destination: string,
	): Promise<void> {
		const entriesByPath = new Map<string, RunSnapshotEntry>();
		for (const entry of snapshot.entries) {
			this.materializedPath(destination, entry.path);
			if (entriesByPath.has(entry.path))
				throw new Error(`Duplicate snapshot path: ${entry.path}`);
			entriesByPath.set(entry.path, entry);
		}
		for (const entry of snapshot.entries) {
			let parent = dirname(entry.path);
			while (parent !== ".") {
				if (entriesByPath.get(parent)?.type !== "directory")
					throw new Error(`Snapshot parent is not a directory: ${parent}`);
				parent = dirname(parent);
			}
			if (entry.type === "directory")
				await mkdir(this.materializedPath(destination, entry.path), {
					recursive: true,
				});
		}
		for (const entry of snapshot.entries) {
			if (entry.type === "directory") continue;
			const path = this.materializedPath(destination, entry.path);
			if (entry.type === "symlink") {
				await symlink(entry.target, path);
				continue;
			}
			const bytes = await gunzipBuffer(
				await readFile(this.objectPath(entry.sha256)),
			);
			const actualSha256 = hashBuffer(bytes);
			if (actualSha256 !== entry.sha256)
				throw new Error(`CAS object checksum mismatch: ${entry.sha256}`);
			await writeFile(path, bytes);
			await chmod(path, entry.mode);
			await utimes(path, new Date(entry.mtimeMs), new Date(entry.mtimeMs));
		}
		for (const entry of [...snapshot.entries].reverse()) {
			if (entry.type === "directory")
				await chmod(this.materializedPath(destination, entry.path), entry.mode);
		}
	}

	private materializedPath(destination: string, snapshotPath: string): string {
		if (
			snapshotPath.length === 0 ||
			isAbsolute(snapshotPath) ||
			snapshotPath
				.split(/[\\/]/)
				.some((part) => part === ".." || part === "." || part === "")
		)
			throw new Error(`Invalid snapshot path: ${snapshotPath}`);
		const path = resolve(destination, ...snapshotPath.split("/"));
		const pathFromCurrent = relative(destination, path);
		if (pathFromCurrent === ".." || pathFromCurrent.startsWith(`..${sep}`))
			throw new Error(
				`Snapshot path escapes current checkout: ${snapshotPath}`,
			);
		return path;
	}

	private async readSnapshot(id: string): Promise<RunSnapshotManifest> {
		return parseRunSnapshotManifest(
			JSON.parse(await readFile(this.snapshotPath(id), "utf8")),
		);
	}

	private snapshotPath(id: string): string {
		return join(this.snapshotsRoot, `${id}.json`);
	}

	private snapshotRelativePath(id: string): string {
		return relative(this.runRoot, this.snapshotPath(id));
	}

	private assertCheckpointPathMatchesId(checkpoint: NornRunCheckpoint): void {
		const expectedPath = this.snapshotRelativePath(checkpoint.id);
		if (checkpoint.path !== expectedPath)
			throw new Error(
				`Run checkpoint path does not match id: ${checkpoint.id}`,
			);
	}

	private objectPath(sha256: string): string {
		return join(
			this.objectsRoot,
			sha256.slice(0, 2),
			sha256.slice(2, 4),
			`${sha256}.gz`,
		);
	}
}

type RunSnapshotManifest = {
	readonly version: typeof SNAPSHOT_VERSION;
	readonly id: string;
	readonly path: string;
	readonly index: number;
	readonly message: string;
	readonly createdAt: string;
	readonly entries: readonly RunSnapshotEntry[];
};

type RunSnapshotEntry =
	| { readonly path: string; readonly type: "directory"; readonly mode: number }
	| {
			readonly path: string;
			readonly type: "file";
			readonly sha256: string;
			readonly size: number;
			readonly mode: number;
			readonly mtimeMs: number;
			readonly compression: "gzip";
	  }
	| {
			readonly path: string;
			readonly type: "symlink";
			readonly target: string;
	  };

function hashBuffer(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function joinSnapshotPath(parent: string, child: string): string {
	return parent.length === 0 ? child : `${parent}/${child}`;
}

function parseRunSnapshotManifest(value: unknown): RunSnapshotManifest {
	if (!value || typeof value !== "object")
		throw new Error("Invalid run snapshot manifest");
	const snapshot = value as Partial<RunSnapshotManifest>;
	if (snapshot.version !== SNAPSHOT_VERSION)
		throw new Error(
			`Unsupported run snapshot version: ${String(snapshot.version)}`,
		);
	if (typeof snapshot.id !== "string" || snapshot.id.length === 0)
		throw new Error("Invalid run snapshot id");
	if (
		typeof snapshot.index !== "number" ||
		!Number.isInteger(snapshot.index) ||
		snapshot.index < 1
	)
		throw new Error("Invalid run snapshot index");
	if (typeof snapshot.message !== "string")
		throw new Error("Invalid run snapshot message");
	if (typeof snapshot.createdAt !== "string")
		throw new Error("Invalid run snapshot timestamp");
	if (!Array.isArray(snapshot.entries))
		throw new Error("Invalid run snapshot entries");
	return snapshot as RunSnapshotManifest;
}

function parseNornRunCheckpoints(value: unknown): NornRunCheckpoint[] {
	if (!Array.isArray(value)) throw new Error("Invalid run checkpoints");
	return value.map(parseNornRunCheckpoint);
}

function parseNornRunCheckpoint(value: unknown): NornRunCheckpoint {
	if (!value || typeof value !== "object")
		throw new Error("Invalid run checkpoint");
	const checkpoint = value as Partial<NornRunCheckpoint>;
	if (typeof checkpoint.id !== "string" || checkpoint.id.length === 0)
		throw new Error("Invalid run checkpoint id");
	if (typeof checkpoint.path !== "string" || checkpoint.path.length === 0)
		throw new Error("Invalid run checkpoint path");
	if (
		checkpoint.path.split(/[\\/]/).includes("..") ||
		resolve(checkpoint.path) === checkpoint.path
	)
		throw new Error(`Invalid run checkpoint path: ${checkpoint.path}`);
	if (
		typeof checkpoint.index !== "number" ||
		!Number.isInteger(checkpoint.index) ||
		checkpoint.index < 1
	)
		throw new Error("Invalid run checkpoint index");
	if (typeof checkpoint.message !== "string")
		throw new Error("Invalid run checkpoint message");
	if (typeof checkpoint.createdAt !== "string")
		throw new Error("Invalid run checkpoint timestamp");
	return checkpoint as NornRunCheckpoint;
}

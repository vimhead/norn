import { writeTextAtomically } from "@vimhead.dev/norn-core/atomic-files";
import { isNodeError } from "@vimhead.dev/norn-core/errors";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";

const ownerSchema = Type.Object({
	token: Type.String({ format: "uuid" }),
	pid: Type.Integer({ exclusiveMinimum: 0 }),
	host: Type.String(),
	target: Type.String(),
}, { additionalProperties: false });

export class NornFileCoordinator {
	private readonly lockRoot: string;

	constructor(private readonly input: { readonly lockRoot: string; readonly waitTimeoutMs: number }) {
		if (!Number.isSafeInteger(input.waitTimeoutMs) || input.waitTimeoutMs <= 0) throw new Error("Lock wait timeout must be a positive integer");
		this.lockRoot = resolve(input.lockRoot);
	}

	async withExclusiveLock<T>(path: string, operation: (lockedPath: string) => Promise<T>): Promise<T> {
		const target = await this.resolveTarget(path);
		await mkdir(this.lockRoot, { recursive: true, mode: 0o700 });
		const key = createHash("sha256").update(target).digest("hex");
		const lockPath = join(this.lockRoot, `${key}.lock`);
		const stagingPath = await mkdtemp(join(this.lockRoot, `${key}.pending-`));
		const token = randomUUID();
		const marker = `${token}.json`;
		return this.withCleanup({
			operation: async () => {
				await writeFile(join(stagingPath, marker), JSON.stringify({ token, pid: process.pid, host: hostname(), target }), { mode: 0o600 });
				await this.acquire({ stagingPath, lockPath, target });
				return this.withCleanup({
					operation: () => operation(target),
					cleanup: async () => {
						await unlink(join(lockPath, marker));
						await this.removeEmptyLock(lockPath);
					},
				});
			},
			cleanup: () => rm(stagingPath, { recursive: true, force: true }),
		});
	}

	async readText(path: string): Promise<string> {
		return this.withExclusiveLock(path, (lockedPath) => readFile(lockedPath, "utf8"));
	}

	async writeText(path: string, content: string): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		await this.withExclusiveLock(path, (lockedPath) => writeTextAtomically(lockedPath, content));
	}

	private async withCleanup<T>(input: { readonly operation: () => Promise<T>; readonly cleanup: () => Promise<void> }): Promise<T> {
		let result: T;
		try {
			result = await input.operation();
		} catch (error) {
			try { await input.cleanup(); }
			catch (cleanupError) { throw new AggregateError([error, cleanupError], "File operation and lock cleanup failed"); }
			throw error;
		}
		await input.cleanup();
		return result;
	}

	private async resolveTarget(path: string): Promise<string> {
		try {
			return await realpath(path);
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
			const entry = await lstat(path).catch((error: unknown) => {
				if (isNodeError(error) && error.code === "ENOENT") return undefined;
				throw error;
			});
			if (entry?.isSymbolicLink()) throw new Error(`Cannot lock a dangling symbolic link: ${path}`);
			return join(await realpath(dirname(path)), basename(path));
		}
	}

	private async acquire(input: { readonly stagingPath: string; readonly lockPath: string; readonly target: string }): Promise<void> {
		const deadline = Date.now() + this.input.waitTimeoutMs;
		while (true) {
			try {
				await rename(input.stagingPath, input.lockPath);
				return;
			} catch (error) {
				if (!isNodeError(error) || !["ENOTEMPTY", "EEXIST"].includes(error.code ?? "")) throw error;
			}
			await this.reclaimDeadOwner(input);
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for file lock: ${input.target}`);
			await delay(10);
		}
	}

	private async reclaimDeadOwner(input: { readonly lockPath: string; readonly target: string }): Promise<void> {
		try {
			const entries = await readdir(input.lockPath);
			if (entries.length === 0) return;
			if (entries.length !== 1) throw new Error(`Invalid file lock ownership: ${input.lockPath}`);
			const marker = entries[0];
			const owner = Value.Parse(ownerSchema, JSON.parse(await readFile(join(input.lockPath, marker), "utf8")));
			if (marker !== `${owner.token}.json` || owner.target !== input.target || owner.host !== hostname()) {
				throw new Error(`Incompatible file lock ownership: ${input.lockPath}`);
			}
			try {
				process.kill(owner.pid, 0);
				return;
			} catch (error) {
				if (isNodeError(error) && error.code === "EPERM") return;
				if (!isNodeError(error) || error.code !== "ESRCH") throw error;
			}
			// A delayed reaper must never remove a successor's differently named marker.
			await unlink(join(input.lockPath, marker));
			await this.removeEmptyLock(input.lockPath);
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		}
	}

	private async removeEmptyLock(path: string): Promise<void> {
		try {
			await rmdir(path);
		} catch (error) {
			if (!isNodeError(error) || !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code ?? "")) throw error;
		}
	}
}

export function createRunFileCoordinator(runRoot: string): NornFileCoordinator {
	return new NornFileCoordinator({ lockRoot: join(runRoot, "locks"), waitTimeoutMs: 30_000 });
}

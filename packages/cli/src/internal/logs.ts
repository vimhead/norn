import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { NornFileCoordinator } from "./file-coordinator.ts";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { NornLogRef } from "@vimhead.dev/norn";

export type NornLogWriteStream = {
	readonly log: NornLogRef;
	readonly stream: WriteStream;
};

export class NornRunLogs {
	constructor(private readonly logsRoot: string, private readonly files: NornFileCoordinator) {}

	async write(path: string, content: string): Promise<void> {
		await this.files.writeText(this.resolveLogPath(path), content);
	}

	async read(log: NornLogRef): Promise<string> {
		return this.files.readText(this.resolveLogPath(`${log.id}.log`));
	}

	async createWriteStream(log: NornLogRef): Promise<NornLogWriteStream> {
		const absolutePath = this.resolveLogPath(`${log.id}.log`);
		await mkdir(dirname(absolutePath), { recursive: true });
		return {
			log,
			stream: createWriteStream(absolutePath, { encoding: "utf8" }),
		};
	}

	private resolveLogPath(path: string): string {
		if (isAbsolute(path)) throw new Error(`Log path must be relative: ${path}`);
		const resolvedPath = resolve(this.logsRoot, path);
		const relativePath = relative(this.logsRoot, resolvedPath);
		if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
			throw new Error(`Log path escapes logs directory: ${path}`);
		}
		return resolvedPath;
	}
}

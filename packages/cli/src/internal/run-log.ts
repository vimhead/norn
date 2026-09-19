import { readFile } from "node:fs/promises";
import type { NornFileCoordinator } from "./file-coordinator.ts";
import { isNodeError } from "@vimhead.dev/norn-core/errors";
import { writeJsonAtomically } from "@vimhead.dev/norn-core/atomic-files";

export type NornRunManifestEvent = {
	readonly at: string;
	readonly type: string;
	readonly [key: string]: unknown;
};

export type NornRunManifest = {
	readonly id: string;
	readonly name: string;
	readonly workflowId: string;
	readonly runRoot: string;
	readonly workspace: string;
	readonly initialCwd: string;
	readonly startedAt: string;
	readonly events: readonly NornRunManifestEvent[];
};

export class NornRunLogger {
	private isInitialized = false;

	constructor(private readonly input: {
		readonly manifestPath: string;
		readonly manifest: Omit<NornRunManifest, "events">;
		readonly files: NornFileCoordinator;
	}) {}

	static async load(manifestPath: string, files: NornFileCoordinator): Promise<NornRunLogger> {
		const manifest = parseManifest(await files.readText(manifestPath));
		const logger = new NornRunLogger({ manifestPath, manifest, files });
		logger.isInitialized = true;
		return logger;
	}

	async record(event: { readonly type: string; readonly [key: string]: unknown }): Promise<void> {
		await this.input.files.withExclusiveLock(this.input.manifestPath, async (path) => {
			let manifest: NornRunManifest;
			try {
				manifest = parseManifest(await readFile(path, "utf8"));
			} catch (error) {
				if (this.isInitialized || !isNodeError(error) || error.code !== "ENOENT") throw error;
				manifest = { ...this.input.manifest, events: [] };
			}
			if (manifest.id !== this.input.manifest.id) throw new Error("Run manifest identity changed");
			await writeJsonAtomically(path, { ...manifest, events: [...manifest.events, { ...event, at: new Date().toISOString() }] });
			this.isInitialized = true;
		});
	}
}

function parseManifest(content: string): NornRunManifest {
	const manifest = JSON.parse(content) as NornRunManifest;
	if (!manifest || typeof manifest !== "object" || typeof manifest.id !== "string" || !Array.isArray(manifest.events)) throw new Error("Invalid run manifest");
	return manifest;
}

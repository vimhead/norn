import { isAbsolute, relative, resolve, sep } from "node:path";
import type { NornFileCoordinator } from "@vimhead.dev/norn/files";
import type { NornArtifactRef } from "@vimhead.dev/norn";

export class NornArtifacts {
	constructor(private readonly artifactsRoot: string, private readonly files: NornFileCoordinator) {}

	async write(path: string, content: string): Promise<NornArtifactRef> {
		await this.files.writeText(this.resolveArtifactPath(path), content);
		return { path };
	}

	async read(ref: NornArtifactRef): Promise<string> {
		return this.files.readText(this.resolveArtifactPath(ref.path));
	}

	private resolveArtifactPath(path: string): string {
		if (isAbsolute(path)) throw new Error(`Artifact path must be relative: ${path}`);
		const resolvedPath = resolve(this.artifactsRoot, path);
		const relativePath = relative(this.artifactsRoot, resolvedPath);
		if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
			throw new Error(`Artifact path escapes artifacts directory: ${path}`);
		}
		return resolvedPath;
	}
}

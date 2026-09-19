import { chmod, lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isNodeError } from "@vimhead.dev/norn-core/errors";

export async function prepareRunWorkerDirectory(runRoot: string): Promise<string> {
	const directory = join(runRoot, "worker");
	try {
		await mkdir(directory, { mode: 0o555 });
	} catch (error) {
		if (!isNodeError(error) || error.code !== "EEXIST") throw error;
	}
	const metadata = await lstat(directory);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Run worker cwd must be a directory, not a symlink: ${directory}`);
	if ((await readdir(directory)).length !== 0) throw new Error(`Run worker cwd must be empty: ${directory}`);
	await chmod(directory, 0o555);
	return directory;
}

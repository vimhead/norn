import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isNodeError } from "./errors.ts";

export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
	await writeTextAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomically(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	let existingMode: number | undefined;
	try { existingMode = (await stat(path)).mode & 0o777; }
	catch (error) { if (!isNodeError(error) || error.code !== "ENOENT") throw error; }
	const tmpPath = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(tmpPath, content, { encoding: "utf8", mode: existingMode });
		if (existingMode !== undefined) await chmod(tmpPath, existingMode);
		await rename(tmpPath, path);
	} catch (error) {
		await rm(tmpPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

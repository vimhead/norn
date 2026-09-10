import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
	await writeTextAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomically(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmpPath = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(tmpPath, content, "utf8");
		await rename(tmpPath, path);
	} catch (error) {
		await rm(tmpPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

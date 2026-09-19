import { isAbsolute, resolve } from "node:path";

export function requireAbsoluteWorkingDirectory(cwd: string): string {
	if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error("Working directory (cwd) must be an absolute path");
	return resolve(cwd);
}

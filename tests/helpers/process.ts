import assert from "node:assert/strict";

export function readProcessStdout(error: unknown): string {
	assert.ok(error instanceof Error && "stdout" in error);
	assert.ok(typeof error.stdout === "string");
	return error.stdout;
}

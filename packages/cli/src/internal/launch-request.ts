import { randomUUID } from "node:crypto";
import { link, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomically } from "@vimhead.dev/norn-core/atomic-files";
import { isNodeError } from "@vimhead.dev/norn-core/errors";
import type { NornRunLease } from "./run-lease.ts";

export const LAUNCH_REQUEST_FILE_NAME = "launch-request.json";
export const RESUME_REQUEST_FILE_NAME = "resume-request.json";
export const RESUME_START_GRACE_MS = 60_000;

export type NornRunLaunchRequest = {
	readonly version: 1;
	readonly type: "run";
	readonly id: string;
	readonly name: string;
	readonly workflowId: string;
	readonly params: unknown;
	readonly configOverride?: unknown;
	readonly createdAt: string;
};

export type NornRunResumeRequest = {
	readonly version: 1;
	readonly type: "resume";
	readonly id: string;
	readonly requestId?: string;
	readonly params?: unknown;
	readonly createdAt: string;
};

export async function writeRunLaunchRequest(runRoot: string, request: NornRunLaunchRequest): Promise<void> {
	await writeJsonAtomically(join(runRoot, LAUNCH_REQUEST_FILE_NAME), request);
}

export async function readRunLaunchRequest(runRoot: string): Promise<NornRunLaunchRequest> {
	return parseRunLaunchRequest(JSON.parse(await readFile(join(runRoot, LAUNCH_REQUEST_FILE_NAME), "utf8")));
}

export async function writeRunResumeRequest(runRoot: string, request: NornRunResumeRequest): Promise<void> {
	const path = join(runRoot, RESUME_REQUEST_FILE_NAME);
	const stagedPath = `${path}.${randomUUID()}.tmp`;
	try {
		await writeJsonAtomically(stagedPath, request);
		await link(stagedPath, path);
	} finally {
		await rm(stagedPath, { force: true }).catch(() => undefined);
	}
}

export async function readRunResumeRequest(runRoot: string): Promise<NornRunResumeRequest> {
	return parseRunResumeRequest(JSON.parse(await readFile(join(runRoot, RESUME_REQUEST_FILE_NAME), "utf8")));
}

export async function readOptionalRunResumeRequest(runRoot: string): Promise<NornRunResumeRequest | undefined> {
	try {
		return await readRunResumeRequest(runRoot);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
}

export function matchesRunResumeRequest(actual: NornRunResumeRequest | undefined, expected: NornRunResumeRequest): boolean {
	return actual?.id === expected.id && (actual.requestId ?? actual.createdAt) === (expected.requestId ?? expected.createdAt);
}

export async function clearRunResumeRequest(input: { readonly runRoot: string; readonly request: NornRunResumeRequest; readonly lease: NornRunLease }): Promise<void> {
	await input.lease.assertOwned();
	if (matchesRunResumeRequest(await readOptionalRunResumeRequest(input.runRoot), input.request)) {
		await rm(join(input.runRoot, RESUME_REQUEST_FILE_NAME), { force: true });
	}
}

function parseRunLaunchRequest(value: unknown): NornRunLaunchRequest {
	if (!value || typeof value !== "object") throw new Error("Invalid workflow launch request");
	const request = value as Partial<NornRunLaunchRequest>;
	if (request.version !== 1 || request.type !== "run") throw new Error("Unsupported workflow launch request");
	if (typeof request.id !== "string" || request.id.length === 0) throw new Error("Invalid workflow launch request id");
	if (typeof request.name !== "string" || request.name.length === 0) throw new Error("Invalid workflow launch request name");
	if (typeof request.workflowId !== "string" || request.workflowId.length === 0) throw new Error("Invalid workflow launch request workflow id");
	if (typeof request.createdAt !== "string" || Number.isNaN(Date.parse(request.createdAt))) throw new Error("Invalid workflow launch request timestamp");
	return request as NornRunLaunchRequest;
}

function parseRunResumeRequest(value: unknown): NornRunResumeRequest {
	if (!value || typeof value !== "object") throw new Error("Invalid workflow resume request");
	const request = value as Partial<NornRunResumeRequest>;
	if (request.version !== 1 || request.type !== "resume") throw new Error("Unsupported workflow resume request");
	if (typeof request.id !== "string" || request.id.length === 0) throw new Error("Invalid workflow resume request id");
	if (request.requestId !== undefined && (typeof request.requestId !== "string" || request.requestId.length === 0)) throw new Error("Invalid workflow resume request token");
	if (typeof request.createdAt !== "string" || Number.isNaN(Date.parse(request.createdAt))) throw new Error("Invalid workflow resume request timestamp");
	return request as NornRunResumeRequest;
}

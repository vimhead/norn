export type NornRuntimeInvocation = {
	readonly executable: string;
	readonly args: readonly string[];
};

export class RuntimeResolutionError extends Error {}

export function resolveNornRuntime(input: {
	readonly cwd: string;
	readonly executableOverride: string | null;
	readonly isProjectTrusted: boolean;
	readonly nodeExecutable: string;
}): Promise<NornRuntimeInvocation>;

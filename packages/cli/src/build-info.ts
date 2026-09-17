import { NORN_GENERATED_BUILD_INFO } from "./generated-build-info.ts";

export type NornBuildInfo = NornUnknownBuildInfo | NornNpmRegistryBuildInfo | NornGithubReleaseBinaryBuildInfo;

export type NornUnknownBuildInfo = {
	readonly kind: "unknown";
	readonly version: string;
	readonly commit: string | null;
	readonly upgrade: {
		readonly supported: false;
		readonly reason: string;
	};
};

export type NornNpmRegistryBuildInfo = {
	readonly kind: "npm-registry";
	readonly version: string;
	readonly commit: string | null;
	readonly packageSpec: string;
	readonly upgrade: {
		readonly supported: false;
		readonly reason: string;
	};
};

export type NornGithubReleaseBinaryBuildInfo = {
	readonly kind: "github-release-binary";
	readonly version: string;
	readonly commit: string | null;
	readonly repository: string;
	readonly releaseTag: string;
	readonly assetName: string;
	readonly checksumAssetName: string;
};

export const NORN_BUILD_INFO: NornBuildInfo = NORN_GENERATED_BUILD_INFO;

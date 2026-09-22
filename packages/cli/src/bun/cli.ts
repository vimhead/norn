#!/usr/bin/env bun
import { homedir } from "node:os";
import { resolveNornAgentDirectory } from "../internal/agent-directory.ts";
import {
	materializePiAssets,
	resolvePiAssetsCacheRoot,
} from "../internal/pi-assets.ts";
import {
	piAssetArchive,
	registerBunOAuthFlows,
} from "./pi-assets.generated.ts";
import { documentationAssets } from "./documentation-assets.generated.ts";

process.env.NORN_AGENT_DIR = resolveNornAgentDirectory({
	home: homedir(),
	environment: process.env,
});
process.env.PI_CODING_AGENT_DIR = process.env.NORN_AGENT_DIR;
process.env.PI_PACKAGE_DIR = await materializePiAssets({
	archive: piAssetArchive,
	cacheRoot: resolvePiAssetsCacheRoot({
		platform: process.platform,
		home: homedir(),
		environment: process.env,
	}),
});
registerBunOAuthFlows();
const { main } = await import("../cli.ts");
await main(process.argv.slice(2), {
	kind: "embedded",
	bundle: documentationAssets,
});

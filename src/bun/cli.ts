#!/usr/bin/env bun
import { homedir } from "node:os";
import { materializePiAssets, resolvePiAssetsCacheRoot } from "../internal/pi-assets.ts";
import { piAssetArchive } from "./pi-assets.generated.ts";
import { documentationAssets } from "./documentation-assets.generated.ts";

process.env.PI_PACKAGE_DIR = await materializePiAssets({
	archive: piAssetArchive,
	cacheRoot: resolvePiAssetsCacheRoot({ platform: process.platform, home: homedir(), environment: process.env }),
});
const { main } = await import("../cli.ts");
await main(process.argv.slice(2), { kind: "embedded", bundle: documentationAssets });

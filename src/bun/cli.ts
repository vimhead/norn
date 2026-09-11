#!/usr/bin/env bun
import { main } from "../cli.ts";
import { documentationAssets } from "./documentation-assets.generated.ts";

await main(process.argv.slice(2), { kind: "embedded", bundle: documentationAssets });

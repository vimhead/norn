#!/usr/bin/env node
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const cli = await jiti.import("../src/cli.ts");
await cli.main(process.argv.slice(2), { kind: "local", root: fileURLToPath(new URL("..", import.meta.url)) });

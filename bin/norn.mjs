#!/usr/bin/env node
import { createJiti } from "jiti";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

process.env.PI_PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.resolve("@earendil-works/pi-coding-agent")));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { resolveNornAgentDirectory } = await jiti.import("../src/internal/agent-directory.ts");
process.env.NORN_AGENT_DIR = resolveNornAgentDirectory({ home: homedir(), environment: process.env });
process.env.PI_CODING_AGENT_DIR = process.env.NORN_AGENT_DIR;
const cli = await jiti.import("../src/cli.ts");
await cli.main(process.argv.slice(2), { kind: "local", root: fileURLToPath(new URL("..", import.meta.url)) });

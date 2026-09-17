#!/usr/bin/env node
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

process.env.PI_PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.resolve("@earendil-works/pi-coding-agent")));
const { resolveNornAgentDirectory } = await import("../dist/internal/agent-directory.js");
process.env.NORN_AGENT_DIR = resolveNornAgentDirectory({ home: homedir(), environment: process.env });
process.env.PI_CODING_AGENT_DIR = process.env.NORN_AGENT_DIR;
const cli = await import("../dist/cli.js");
await cli.main(process.argv.slice(2), { kind: "local", root: fileURLToPath(new URL("../assets", import.meta.url)) });

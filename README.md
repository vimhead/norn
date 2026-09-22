# Norn

Norn is a portable runtime for reusable agent-driven and code-driven TypeScript
workflows. Author them with the SDK, then discover, run, inspect, and recover them
through the CLI from any harness. Agents run on the bundled
[Pi coding agent](https://pi.dev); code-only workflows need no model.

## Getting started

1. [Install Norn](#installation), including agent authentication.

2. **Write a workflow.** Save this as `summarize.ts` in a new directory:

   ```ts
   import { workflow } from "@vimhead.dev/norn";
   import { Type } from "typebox";

   const summarize = workflow({
     name: "summarize",
     entrypoint: {
       instructions: "Use when you need a concise summary of supplied text.",
     },
     args: Type.Object({ text: Type.String({ minLength: 1 }) }),
     async execute({ args, paths, agents, run }) {
       const result = await agents.prompt({
         label: "summarize",
         cwd: paths.workspace,
         tools: [],
         systemPrompt: "Summarize the supplied text concisely.",
         prompt: args.text,
         response: Type.Object({ summary: Type.String() }),
       });
       return run.complete(result);
     },
   });

   export default [summarize];
   ```

3. **Register and run it.** Create `norn.project.json` alongside the workflow:

   ```json
   {
     "version": 1,
     "workflows": ["./summarize.ts"]
   }
   ```

   From that directory:

   ```sh
   printf '%s\n' '{"args":{"text":"The launch moved to Friday."}}' \
     | norn runs start summarize

   norn runs wait <run-id>
   ```

   Replace `<run-id>` with the ID returned by `start`. On completion, read the
   summary from `run.outcome.metadata.summary`.

For a fuller example combining a Git command, an agent, and a saved file, see
[the Git summary workflow](examples/getting-started/README.md).

See the [documentation index](docs/README.md) for focused references and the
[SDK types](packages/sdk/src/api.ts) for API details.

## Installation

Install the runtime, authenticate for workflows that use Norn agents, and
optionally connect your harness with an adapter. Direct CLI use needs no adapter.

### 1. Install the runtime

Install the rolling npm `tip` release (Node `>=22.19.0`):

```bash
npm install -g @vimhead.dev/norn-cli@tip
norn version
```

Releases are prereleases, not stable `latest` releases. For a standalone binary
without Node, use the matching GitHub `tip` release:

```bash
curl -fsSL https://github.com/vimhead/norn/releases/download/tip/install.sh | sh
```

Set `NORN_INSTALL_DIR` to select a different binary installation directory.

[Runtime selection](docs/cli.md#select-the-runtime) covers source checkout invocation
and keeping examples/docs matched to the executable. Upgrade discovery:

```bash
norn upgrade --dry-run
```

### 2. Authenticate Norn agents

Open the bundled Pi interface; no separate Pi installation is required:

```bash
norn pi
```

Inside the interactive session:

1. Run `/login`, choose a provider, and complete its authentication flow.
2. Run `/model`, highlight a model, and press **Ctrl+S** to save the startup default.
3. Run `/quit`.

Model-free workflows need no provider authentication. For other credential
methods, custom providers, and Norn's configuration directory, see
[providers and authentication](docs/providers.md).

### 3. Optionally connect your harness

The shipped Pi and Cursor adapters deliver Norn documentation context to your
harness. Installing Norn alone does not register an adapter. Claude Code, Codex,
and other harnesses can [invoke the CLI directly](docs/cli.md#javascript-client-and-other-harnesses).

#### Pi

With Pi already installed and `norn` available on `PATH`, install the adapter
and start a new session:

```bash
pi install npm:@vimhead.dev/pi-norn@tip
pi
```

To select a CLI executable outside `PATH`:

```bash
pi --norn-executable /absolute/path/to/norn
```

#### Cursor

1. Open **Customize** in Cursor and choose **From GitHub Repository**.
2. Enter `https://github.com/vimhead/norn` to import the marketplace.
3. Install the **norn** plugin, choosing user or project scope.
4. Start a new agent conversation.

By default the adapter runs `norn` from `PATH`. To select a CLI executable
outside `PATH`, start Cursor with an executable path:

```bash
NORN_EXECUTABLE=/absolute/path/to/norn cursor .
```

Need an adapter for another harness? [Open an issue](https://github.com/vimhead/norn/issues/new)
with the harness name.

## Build workflows with the Norn SDK

Install SDK types and helpers for TypeScript/editor support:

```bash
npm install -D @vimhead.dev/norn@tip
```

Use the SDK version reported by `norn version` for an exact runtime match. Runtime
execution also supplies [virtual SDK imports](docs/projects.md#import-and-reload),
so standalone examples need no local SDK installation.

## Development

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm check
pnpm test
pnpm pack:dry
```

Run `pnpm format` to format source, examples, and supported fenced code in Markdown.
Prettier targets 80 columns and preserves Markdown prose wrapping. Generated files,
build output, dependencies, and the lockfile are excluded.

`pnpm install` enables the Husky pre-commit hook. Commits run lint-staged to format
staged files with Prettier and stage the formatting changes, preserving unstaged
edits. CI checks formatting across the repository.

Use the pnpm version pinned in `package.json`. The private root coordinates three
published workspaces: `packages/sdk`, `packages/cli`, and `packages/pi-norn`.
`packages/core` is private source shared through consumer builds, not a fourth
published dependency. No separate core build is needed.

Checks cover package builds, TypeScript (including examples, adapters, scripts,
and tests), runtime regressions, isolated npm installations, and standalone binaries.
`pack:dry` creates local tarballs without publishing.

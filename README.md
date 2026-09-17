# Norn

Norn is a harness-agnostic workflow framework and runtime built primarily for
agents. Use the Norn SDK to write reusable agent-driven and code-driven TypeScript
workflows, then discover, run, inspect, and recover them through the CLI.

Norn is intended as a portable replacement for harness-specific subagents and
workflow extensions. Use it from Claude Code, Pi, Codex, or any other harness
that can invoke its CLI.

Norn agents are powered by the bundled, open-source and extensible
[Pi coding agent](https://pi.dev). Your outer harness does not need to be Pi,
and code-only workflows do not require a model.

- [Documentation index](docs/README.md) — focused references by capability
- [Create → run → change a workflow](examples/minimal-workflow/README.md) — code-driven, no model required
- [Norn agent → saved artifact → analysis](examples/agent-then-analysis/README.md) — agent-driven, with a recoverable transition
- [Norn SDK types](src/api.ts)

## Installation

Install the runtime, authenticate for workflows that use Norn agents, and
optionally connect your harness with an adapter. Direct CLI use needs no adapter.

### 1. Install the runtime

Install Norn from the rolling `tip` release:

```bash
curl -fsSL https://github.com/vimhead/norn/releases/download/tip/install.sh | sh
norn version
```

Use `NORN_INSTALL_DIR` for a different binary installation directory:

```bash
curl -fsSL https://github.com/vimhead/norn/releases/download/tip/install.sh | NORN_INSTALL_DIR=/usr/local/bin sh
```

Alternatively, install the npm package from GitHub, including local docs, examples,
and source:

```bash
npm install github:vimhead/norn
# or
npm install -g github:vimhead/norn
```

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
[providers and authentication](setup/providers.md).

### 3. Optionally connect your harness

The shipped Pi and Cursor adapters deliver Norn documentation context to your
harness. Installing Norn alone does not register an adapter. Claude Code, Codex,
and other harnesses can [invoke the CLI directly](docs/cli.md#javascript-client-and-other-harnesses).

#### Pi

With Pi already installed and `norn` available on `PATH`, install the adapter
and start a new session:

```bash
pi install git:github.com/vimhead/norn
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

## Setting up a Norn project

[Projects and loading](docs/projects.md) covers initialization, registration,
reusable configuration, dependencies, source reload, and discovery diagnostics.

## Build workflows with the Norn SDK

[Workflow authoring](docs/workflows.md) covers declarations, implementations,
commands, and run outcomes. Focused companion references:

- [Norn agents](docs/agents.md)
- [State, artifacts, and workspaces](docs/persistence.md)
- [Composition and reuse](docs/composition.md)
- [Recovery and gates](docs/recovery.md)

The larger [worktree development loop](examples/worktree-development-loop/README.md)
is an optional composition example, not a required workflow architecture.

## Run workflows with Norn

[CLI and client](docs/cli.md) covers live contract discovery, JSON invocation,
launch/wait semantics, results, and use from other harnesses.

## Development

```bash
npm run check
npm test
npm run pack:dry
```

Checks cover TypeScript (including examples, adapters, scripts, and tests) and Vitest regressions.

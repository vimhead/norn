# norn

Reusable, harness-agnostic workflows powered by Pi agents.

Norn lets a project package agent workflows once and run them from any harness
that can call its CLI or client. Agents can also author, exercise, repair, and
retain a missing capability while completing an ordinary task.

- [Documentation index](docs/README.md) — focused references by capability
- [Create → run → change a workflow](examples/minimal-workflow/README.md) — no model required
- [Worker → saved artifact → analysis](examples/worker-then-analysis/README.md) — native workers and a recoverable transition
- [Public authoring types](src/api.ts)

## Installation

Install the CLI, then install the adapter for your agent harness. CLI-only usage
does not require an adapter.

### 1. Install the CLI

Install the CLI from the rolling `tip` release:

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

### 2. Install an adapter

Adapters connect your agent harness to the CLI installed in step 1; installing
the CLI alone does not register an adapter in your harness.

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

## Writing workflows

[Workflow authoring](docs/workflows.md) covers declarations, implementations,
commands, and run outcomes. Focused companion references:

- [Agents](docs/agents.md)
- [State, artifacts, and workspaces](docs/persistence.md)
- [Composition and reuse](docs/composition.md)
- [Recovery and gates](docs/recovery.md)

The larger [worktree development loop](examples/worktree-development-loop/README.md)
is an optional composition example, not a required workflow architecture.

## Using the CLI

[CLI and client](docs/cli.md) covers live contract discovery, JSON invocation,
launch/wait semantics, results, and use from other harnesses.

## Development

```bash
npm run check
npm test
npm run pack:dry
```

Checks cover TypeScript (including examples, adapters, scripts, and tests) and Vitest regressions.

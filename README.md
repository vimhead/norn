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

## Installing the agent skill

The [norn skill](skills/norn/SKILL.md) teaches task-time creation, use, composition,
and repair. Install it separately with the Skills CLI:

```bash
npx skills add vimhead/norn --skill norn
```

List available skills without installing:

```bash
npx skills add vimhead/norn --list
```

This installs the skill, not the runtime. No Pi integration extension is required.
The package also advertises `skills/` through Pi package metadata.

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

Checks cover TypeScript (including examples and adapters), skill packaging, and regression tests.

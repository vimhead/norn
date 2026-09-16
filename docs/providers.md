# Providers and authentication

`norn pi` runs the Pi CLI bundled with the selected Norn installation. It needs
neither a separate Pi installation nor a Norn project. Everything after `pi` is
forwarded to Pi, including its terminal UI, package commands, and output modes:

```bash
norn pi --version
norn pi --help
norn pi
```

In the interactive session, use `/login` to authenticate, `/model` to select and
save a default model, and `/quit` to exit. Configure these before launching native
workers: detached execution cannot conduct interactive login. Authentication in
the outer harness does not automatically authenticate a worker's provider.

## Shared configuration

The proxy and native workers use Pi's agent directory, normally `~/.pi/agent/`:

- `settings.json` — installed packages and default provider/model
- `auth.json` — saved API keys and OAuth credentials
- `models.json` — custom endpoints, models, and authentication configuration

`PI_CODING_AGENT_DIR` selects another directory. Set it consistently for both
`norn pi` and workflow execution. An SDK caller supplying `agentDir` must point
the setup command at that same directory. Project settings and extension discovery
also depend on the working directory; installing a provider globally avoids making
it available only in one project or worktree.

Login is optional when credentials are supplied another way. Workers inherit
provider environment variables such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
Custom providers can resolve environment variables or secret-manager commands
through `models.json`. Keep credentials out of project files and version control.
Finding a configured key or listing a model is not proof that a provider accepts it.

## Third-party provider packages

Pi provider extensions are separate from Norn workflow plugins and outer-harness
adapters. They register providers through Pi's APIs; do not put them in
`norn.project.json` or install them only in Cursor's plugin marketplace.

Use `norn pi install` with the package's published npm spec or Git URL. For example:

```bash
norn pi install npm:pi-cursor-sdk@0.3.6
norn pi --list-models cursor
norn pi
```

This installs into the shared Pi configuration. Native workers load installed
extensions before choosing their default model. Select the new provider using
`/model`; an explicit workflow model takes precedence over that saved default.
Use `norn pi list` to inspect installations and `norn pi remove <source>` to remove
one. Upgrade bundled Pi by upgrading Norn, not by using Pi's self-update command.
`norn pi update --extensions` updates unpinned extension packages.

Review third-party packages before installation: extensions and dependency install
scripts execute code with the user's permissions. npm packages require Node/npm;
Git sources additionally require Git. A standalone Norn binary does not bundle
those installers or every third-party package's native dependencies. Check package
requirements against `norn pi --version` and the local platform.

### Cursor SDK example

[pi-cursor-sdk](https://pi.dev/packages/pi-cursor-sdk) registers the `cursor`
provider. Its API key must be a **Cursor SDK API key** (user or service account),
not a Team Admin key. It does not reuse Cursor Desktop or Agent CLI login.

After installation, run `/login cursor` inside `norn pi` and enter the SDK key,
or supply `CURSOR_API_KEY` to Norn's launching environment. Select a Cursor model
with `/model`. A newly started session reloads the provider; its model listing can
contain fallback models even without working credentials.

Keep the provider's **local runtime and Pi tool bridge enabled** for Norn workers.
Norn requires its structured-response tool, and attached resources also expose Pi
tools. The provider's cloud mode does not expose that local bridge. Cursor-native
tools are a separate surface: restricting Norn's `tools` list does not disable
Cursor's own tools or ambient configuration. See the package's documentation for
its runtime and isolation controls.

Installation and fallback-model discovery for version 0.3.6 were exercised through
a standalone Norn binary without credentials. Authenticated Cursor inference and
its Norn response-tool bridge require a separate live check; model discovery alone
does not establish end-to-end compatibility.

## Custom endpoints without an extension

For a provider using an existing API protocol, add its configuration under
`providers` in the shared `models.json`, preserving existing entries:

```json
{
  "providers": {
    "team-gateway": {
      "baseUrl": "https://gateway.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$TEAM_GATEWAY_API_KEY",
      "models": [{ "id": "team-model" }]
    }
  }
}
```

Set `TEAM_GATEWAY_API_KEY` in the launching environment, then select the model
through `norn pi`. A provider with a different protocol or custom OAuth flow needs
a compatible Pi provider extension, not just an `auth.json` entry. Use that
extension's documented authentication method; Norn does not duplicate its login
or token-refresh implementation.

## Standalone assets

Compiled Norn includes the bundled Pi version metadata, themes, documentation,
examples, and export assets. It extracts and verifies them in a content-specific
cache before loading Pi. `NORN_PI_CACHE_DIR` overrides its root; otherwise it uses
`~/Library/Caches/norn/pi` on macOS, `$XDG_CACHE_HOME/norn/pi` (or
`~/.cache/norn/pi`) on Linux, and `%LOCALAPPDATA%/norn/pi` on Windows.
The asset cache is not the credential directory. A modified or incomplete entry
causes an error naming the entry to remove before retrying.

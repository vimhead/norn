# Pi integration

The [Pi adapter](../adapters/pi.ts) delivers the selected Norn runtime's [`docs intro`](cli.md) through `before_agent_start`. It adds no tools, workflow catalogue, or orchestration layer. Norn's documentation index remains the capability router.

## Install and select a runtime

Install the [Norn CLI](../README.md#installation), then install this repository as a Pi package:

```bash
pi install git:github.com/vimhead/norn
pi
```

For a local checkout with dependencies installed:

```bash
pi install /absolute/path/to/norn-checkout
pi --norn-executable /absolute/path/to/norn-checkout/bin/norn.mjs
```

Pi package metadata discovers `adapters/pi.ts` and the existing `skills/` resource. Installing only the skill with the Skills CLI does not install this adapter. No user settings are changed by loading the adapter itself.

`--norn-executable` accepts one executable name or path, resolved from the session's working directory. The default is `norn` on PATH. It does not accept command arguments or shell syntax. Unix source/npm entrypoints require Node on PATH; on Windows, select a native `norn.exe` rather than a shell shim. The selected runtime must support `docs intro`.

| Decision | GOOD | BAD |
|---|---|---|
| IF PATH selects a different runtime than intended, THEN pass its executable path with `--norn-executable`. ELSE use the default. | `pi --norn-executable '/opt/Norn tools/norn'`. | Passing `'node /checkout/bin/norn.mjs'` as one executable or assuming the adapter selects its own package's CLI. |
| IF Pi reports that the introduction is unavailable, THEN invoke that same executable with `docs intro` and fix the reported installation/cache problem. ELSE leave runtime selection unchanged. | Repair the selected installation and submit the next task. | Silently switching to another installation's docs or copying a stale intro into the system prompt. |

## Prompt behavior and boundaries

Each outer `before_agent_start` invokes `docs intro` anew through Pi's execution API, requesting a ten-second timeout. The adapter validates the JSON response and appends its compact `intro` text to the already-chained `event.systemPrompt`. Custom prompts, project context, skill advertisements, and other extensions' contributions remain intact. Its marked block is added at most once to that prompt; it does not accumulate across turns or `/reload`.

A missing executable, unsuccessful command, or invalid response leaves the prompt unchanged. The adapter requests one Pi warning notification per consecutive failure period, retries on the next task, and retains no stale introduction. It does not expose command output or full prompts in diagnostics.

The introduction's paths and invocation come from the selected runtime, not from the adapter's installation. Skill advertisement remains Pi's responsibility and can reflect a separately installed skill. The adapter does not rewrite Pi resources or resolve skill-name collisions.

| Decision | GOOD | BAD |
|---|---|---|
| IF Pi advertises a different skill installation than intended, THEN adjust Pi's skill/package configuration to select the matching copy. ELSE retain the existing advertisement. | Inspect Pi's resource collision diagnostic and remove the unintended duplicate resource selection. | Assuming an executable flag also replaces an independently installed skill. |

Native Norn workers are excluded whenever their dedicated response tool is present in Pi's full tool registry, even when inactive. Exclusion happens before CLI execution, including after reload. This applies to all native workers, not just assessors; author-capable worker delivery is separate. It does not suppress other Pi resources or turn resource discovery into a sandbox. Other restricted SDK sessions can exclude this extension through Pi package resource filtering.

Workflow source is not cached by the adapter. The intro points callers to live CLI discovery; source reload and validation follow [projects and loading](projects.md).

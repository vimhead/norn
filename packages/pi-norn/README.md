# Norn for Pi

Deliver the selected Norn runtime's documentation and
[workflow introductions](https://github.com/vimhead/norn/blob/main/docs/cli.md#workflow-introduction)
to outer Pi sessions.
Install the Norn CLI separately, then:

```bash
pi install npm:@vimhead.dev/pi-norn@tip
pi
```

Use [project-local runtime selection](https://github.com/vimhead/norn#project-local-runtime-selection)
with `.nornrc.json` to launch an installed CLI dependency without global Norn.
`pi --norn-executable /absolute/path/to/norn` overrides project selection;
without either, the adapter selects `norn` from `PATH`.
It does not carry another Norn runtime or SDK and does not inject authoring context
into Norn-managed agent sessions. Repository runtime configuration and workflow
discovery are skipped in untrusted projects. Both introductions refresh at session
start or `/reload`.

[Runtime installation](https://github.com/vimhead/norn#installation).

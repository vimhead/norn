# Norn for Pi

Deliver the selected Norn runtime's documentation and
[workflow introductions](https://github.com/vimhead/norn/blob/main/docs/cli.md#workflow-introduction)
to outer Pi sessions.
Install the Norn CLI separately, then:

```bash
pi install npm:@vimhead.dev/pi-norn@tip
pi
```

The adapter selects `norn` from `PATH`, or `pi --norn-executable /absolute/path/to/norn`.
It does not carry another Norn runtime or SDK and does not inject authoring context
into Norn-managed agent sessions. Workflow discovery is skipped in untrusted
projects. Both introductions refresh at session start or `/reload`.

[Runtime installation](https://github.com/vimhead/norn#installation).

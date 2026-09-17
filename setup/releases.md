# Rolling releases

The public npm packages are `@vimhead.dev/norn`, `@vimhead.dev/norn-cli`, and
`@vimhead.dev/pi-norn`. The root and core workspaces are private.

## Local preparation

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm pack:dry
```

`pack:dry` writes real pnpm tarballs and a checksum manifest into `dist/npm/`;
it does not publish. pnpm rewrites the CLI's workspace dependency to the exact
Norn library version. Consumer builds inline private core code.

## One-time npm bootstrap

An npm owner with access to the `vimhead.dev` organization must publish each new
package before configuring its trusted publisher. Use a disposable checkout so
release version stamping does not modify the development checkout:

```bash
npm login --registry=https://registry.npmjs.org/
git worktree add --detach /tmp/norn-bootstrap HEAD
cd /tmp/norn-bootstrap
pnpm install --frozen-lockfile
pnpm release:prepare 0.1.0-tip.0 "$(git rev-parse HEAD)"
pnpm release:pack
pnpm test
pnpm release:publish --interactive
```

Choose an unused prerelease version if `0.1.0-tip.0` already exists. The publication
command prompts through npm for any required authentication/2FA; never put
credentials in repository files. It publishes the library before the CLI and
adapter, with public access and the `tip` tag, never `latest`.

For **each** package, configure an npm trusted publisher:

- Provider: GitHub Actions
- Organization/user: `vimhead`
- Repository: `norn`
- Workflow filename: `release.yml`
- Environment: unset (the workflow does not name one)
- Allowed action: enable direct `npm publish`, not only staged publishing

Use npm's [trusted-publisher settings](https://docs.npmjs.com/trusted-publishers/).
GitHub-hosted runners request OIDC credentials through `id-token: write`; no npm
publishing token is stored in GitHub secrets. Public releases include provenance.

## Continuous tip publication and recovery

After a successful `Test` run on `main`, `Release Tip` stamps all three packages
with `0.1.0-tip.<GitHub-run-id>.<attempt>` and the tested commit. It validates and
packs npm artifacts, builds standalone binaries, then publishes only if the
selected commit is still `main`. Manual dispatch performs the same checks.
Only after all npm packages are verified does it update the GitHub `tip` release.

npm versions are immutable. A workflow rerun gets a new attempt/version, so a
partial prior publication is retained rather than overwritten. Repeating the
publication command for the same artifacts skips an existing package only when
its integrity and `tip` version match; conflicting bytes or a moved tag fail
closed and require a new version. Completed npm publication followed by a GitHub
failure can likewise be repaired by rerunning the workflow.

npm tags move package by package; npm and GitHub do not provide a cross-registry
transaction. The CLI always uses its exact library dependency, even during a
partial rollout. Install that version of `@vimhead.dev/norn` for matching editor
types rather than assuming independently read `tip` tags are atomic.

Trusted publishing authenticates `npm publish`, not general tag-management
commands. The workflow sets `tip` through publication itself; it does not rely on
`npm dist-tag` or a long-lived token for a separate promotion step.

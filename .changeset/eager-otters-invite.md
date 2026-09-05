---
"@aburi/github-action": minor
---

Run the CLI the project installed, so a config that names a plugin by package has one

The action resolved `aburi` one way: `pnpm dlx @aburi/cli@<version>`, which installs the CLI into
the pnpm store rather than into the checkout. The CLI resolves a plugin ref from its own location,
so `languages: ["lang-typescript"]` — the line `aburi init` writes into every TypeScript workspace
it detects — resolved from the store copy of `@aburi/cli` and found nothing:

```
Failed to import plugin "lang-typescript" (resolved to "@aburi/lang-typescript"):
Cannot find package '@aburi/lang-typescript'
```

That is exit 3 before a single file is parsed, and no `pnpm add` in the consumer's project changes
it, because the consumer's `node_modules` is not on that resolution path. The documented quick
start installs the CLI and its plugins as devDependencies; the documented action could use neither.
(A plugin named by relative path was always fine: those resolve against the workspace root.)

The new `cli` input picks the resolution. `dlx` is the old behaviour and stays the default — it
needs no install step, and it suits a config that names no plugin by package. `workspace` runs the
`@aburi/cli` the project installed, resolved from `working-directory`, with the project's plugins
beside it and the project's lockfile deciding the version. `version`, `node-version` and
`pnpm-version` do not apply there: the caller installed the workspace with a toolchain of their
own, and re-running `actions/setup-node` would swap it out from under that install, so the two
setup steps are skipped as well.

Resolution goes through Node's resolver — `@aburi/cli`'s manifest, then its `bin.aburi` — rather
than through a `node_modules/.bin` entry, which npm, yarn and bun projects have no `pnpm exec` to
reach and a workspace that builds its own CLI does not have at all: the bin file is not there when
the install writes the links, and no later install recreates it, the tree being up to date by then.
Yarn PnP is the one arrangement this does not serve, having no `node_modules`; it needs `cli: dlx`.

The resolver is a script (`scripts/resolve-cli-bin.mjs`) rather than a heredoc, so it is testable
and tested. It answers with the bin's path, or with one line saying which of three things is wrong:
`@aburi/cli` is not installed where it looked, the manifest declares no `aburi` command, or the bin
it names does not exist — the last being a workspace that installed and did not build, which
otherwise reached the runner as the CLI's own `MODULE_NOT_FOUND` and got reported as a runtime
error in the analysed project.

A `cli` value that is neither `dlx` nor `workspace` is exit 2 from the input-validation step, next
to the `format` check. So is `comment`, now: every value but `true` read as false there, so
`comment: yes` ran green, posted nothing, and cleared the `comment=true` + `format=json` check on
the way past.

`@aburi/github-action`'s contract now has a design doc, `docs/design/github-action.md`.

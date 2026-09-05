---
"@aburi/github-action": minor
---

Run the CLI the project installed, so a config that names a plugin has one

The action resolved `aburi` one way: `pnpm dlx @aburi/cli@<version>`, which installs the
CLI into the pnpm store rather than into the checkout. Node resolves a plugin ref from the
importing module's own location, so `languages: ["lang-typescript"]` — the line
`aburi init` writes into every TypeScript workspace it detects — resolved from the store
copy of `@aburi/cli` and found nothing:

```
Failed to import plugin "lang-typescript" (resolved to "@aburi/lang-typescript"):
Cannot find package '@aburi/lang-typescript'
```

That is exit 3 before a single file is parsed, and no `pnpm add` in the consumer's project
changes it, because the consumer's `node_modules` is not on that resolution path. The
documented quick start installs the CLI and its plugins as devDependencies; the documented
action could not use either.

The new `cli` input picks the resolution. `dlx` is the old behaviour and stays the default —
it needs no install step, and it suits a config that names no plugin. `workspace` resolves
`@aburi/cli` from `working-directory` and runs its bin on `node`: the CLI in the project's
own `node_modules`, with the project's plugins beside it and the project's lockfile deciding
the version. Resolution goes through Node rather than a `node_modules/.bin` entry, so it
holds for npm, yarn and bun as well as pnpm — and for a workspace that builds the CLI from
source, where no bin link exists at all, because the bin file is not there when the install
writes the links and a later install does not recreate it. A `working-directory` with no
`@aburi/cli` in it is exit 2 with a message that says so. `version`, `node-version` and `pnpm-version` are ignored in that mode: the
caller installed the workspace before calling us, and re-running `actions/setup-node`
would swap the toolchain out from under that install. The two setup steps are skipped
there for the same reason.

Anything other than `dlx` or `workspace` is exit 2 from the input-validation step, next to
the `format` check, rather than a confusing failure four steps later.

# GitHub Action

The contract of `@aburi/github-action`: a composite action that runs `aburi diff` for a pull
request, posts the report as one comment it keeps rewriting, and fails the check when a
`--fail-on` gate trips.

See: [`cli-spec.md`](./cli-spec.md) §6.4 (`aburi diff`), §9 (exit codes), §8 (`--fail-on` grammar)
Implementation: [`packages/github-action/action.yml`](https://github.com/kage1020/Aburi/blob/main/packages/github-action/action.yml)

---

## 1. Purpose

Put the report where reviewers already are, and give CI a status to gate on. The action owns three
things the CLI deliberately does not: deciding which refs a pull request means, deciding where the
Markdown goes, and turning the CLI's exit code into a check.

Everything else it forwards. The action never interprets a diff, never edits the Markdown beyond
prefixing a marker, and never decides what is worth failing on — `--fail-on` is the caller's.

## 2. Inputs

| Input | Default | Contract |
|---|---|---|
| `version` | `latest` | `@aburi/cli` version for `cli: dlx`. Not read under `cli: workspace`. |
| `refspec` | *(empty)* | `<base>..<head>` for `aburi diff`. Empty falls back to the event's base/head SHAs on `pull_request` and `pull_request_target`; any other event with an empty `refspec` is exit 2. |
| `fail-on` | *(empty)* | Forwarded to `--fail-on` verbatim. Empty runs report-only. |
| `config` | *(empty)* | Forwarded to `--config`. |
| `output-dir` | `out` | Forwarded to `--output-dir`, always, because the action reads `diff.md` back. A workspace that sets `config.output.dir` must set this to match. |
| `format` | `both` | Forwarded to `--format`. Must include Markdown when `comment: true`. |
| `working-directory` | `.` | Where the CLI runs, and — under `cli: workspace` — where it is resolved from. |
| `cli` | `dlx` | Resolution mode. §3. |
| `comment` | `true` | Whether to upsert the report as a comment. |
| `token` | `github.token` | Token for the comment API. |
| `node-version` / `pnpm-version` | `24` / `10` | Toolchain for `cli: dlx` only. |

Three input values are validated up front rather than at the point of use — `format`, `cli` and
`comment` — because each of them has a wrong value that otherwise runs green and does nothing
(`comment: yes` is the sharp one: every non-`true` value reads as false, silently). A rejected
input is exit 2 from the first step, which is what "your invocation is wrong" means in
`cli-spec.md` §9.

**No description may hold a GitHub expression.** The runner parses a manifest's descriptions and
defaults as templates, with a context set that does not include `github`, so an expression written
in prose fails the whole manifest to load, for every consumer, before any step runs:

```
action.yml (Line: 19, Col: 18): Unrecognized named-value: 'github'.
Located at position 1 within expression: github.event.pull_request.base.sha
```

A default is evaluated the same way. The one documented exception is the token default every action
uses, which works because `github.token` is in scope there:

```yaml
  token:
    default: ${{ github.token }}
```

## 3. CLI resolution

Two modes, because two things are true at once: a pull request should be able to run Aburi with no
install step, and a plugin the config names has to be loadable.

### 3.1 `dlx`

`pnpm dlx @aburi/cli@<version>`. Nothing to install, and the version is pinned by the caller
rather than by this action's tag.

Its limit is plugin resolution. `packages/cli/src/plugin-loader.ts` imports a plugin ref with a
bare `import(specifier)`, so Node resolves it from **the CLI's own location**. Under `pnpm dlx`
that location is the pnpm store, and nothing the consumer installs in their project is on that
path:

```
Failed to import plugin "lang-typescript" (resolved to "@aburi/lang-typescript"):
Cannot find package '@aburi/lang-typescript' imported from
/root/.local/share/pnpm/store/v11/links/@aburi/cli/0.3.0/…/node_modules/@aburi/cli/…
```

A ref written as a **relative path** (`./plugins/x.mjs`) resolves against the workspace root
instead (`resolveSpecifier`), so it loads here perfectly well. The limit is exactly: plugins named
by package.

### 3.2 `workspace`

The `@aburi/cli` the project installed, resolved from `working-directory` and run on `node`. Its
plugins sit beside it in the same `node_modules`, so a config naming them by package works.

Resolution goes through Node's resolver — `require.resolve("@aburi/cli/package.json")` anchored at
the working directory, then `bin.aburi` from that manifest — and **not** through
`node_modules/.bin/aburi`, for two reasons:

1. **A workspace that builds its own CLI has no such link.** pnpm writes bin links at install
   time. If the bin file does not exist then (it is build output, and the build has not run), the
   link is skipped with a warning, and no later install recreates it: the tree is up to date by
   then, so `pnpm install`, `--force` and `pnpm rebuild` all no-op. This repository is that case.
2. **`pnpm exec` is not everyone's.** npm, yarn and bun projects have no such command, and
   resolving the package works for all of them.

The one arrangement it does not serve is Yarn PnP, which has no `node_modules` and needs
`yarn node` to load `.pnp.cjs`. `cli: workspace` exits 2 there; `cli: dlx` is the answer for a PnP
project whose config names no plugin by package.

The resolver is [`scripts/resolve-cli-bin.mjs`](https://github.com/kage1020/Aburi/blob/main/packages/github-action/scripts/resolve-cli-bin.mjs) —
a committed script rather than an inline heredoc, so that it can be run in tests, and plain `.mjs`
rather than built output, because a consumer references the action by path and nothing builds this
repository for them. Its contract:

| Outcome | stdout | stderr | Exit |
|---|---|---|---|
| Resolved | absolute path of the bin | — | 0 |
| `@aburi/cli` not resolvable from the working directory | — | one line, naming the directory | 2 |
| Manifest declares no `bin.aburi` | — | one line, naming the manifest | 2 |
| `bin.aburi` names a file that is not there | — | one line, saying it is build output | 2 |

Every failure is one line, because the caller renders it as a `::error::` annotation and the Checks
UI shows the first line of one. The existence check matters as much as the resolution: without it,
a missing build reaches the runner as the CLI's own `MODULE_NOT_FOUND` — exit 1, a *runtime* error
by §9, which sends the reader to look at their code rather than at their pipeline.

### 3.3 What this repository's own run does and does not prove

Aburi runs this action on its own pull requests with `cli: workspace`, and the root `package.json`
names `@aburi/cli` and `@aburi/lang-typescript` as workspace devDependencies for it: the first is
what the resolver finds at the repository root, the second so the plugin `aburi.json` names has a
declared provider here rather than one inherited from `@aburi/cli`'s own devDependencies.

Both are workspace links, so a green run here says the mode works against a linked checkout. It
says nothing about a consumer's install, where the manifest sits under
`node_modules/.pnpm/@aburi+cli@x/node_modules/@aburi/cli` and resolution walks up from there. That
path is covered by `test/resolve-cli-bin.test.ts`, whose fixtures are ordinary `node_modules`
trees, and not by CI here.

## 4. Exit codes and the check

The CLI's code is preserved end to end: 0 clean, 1 runtime error, 2 input error, 3 a `--fail-on`
gate or a plugin error. The action's own input errors and a failed CLI resolution are 2, the same
code for the same reason — the caller has to change something.

The step that runs the diff does not fail on a non-zero code; it records it and lets the comment
step run first, because a tripped gate is precisely what the reviewer needs to read. The final step
propagates it, and runs under `if: always()`: a composite action stops at its first failing step,
so without that a 403 in the comment step would end the job on an API error and never report the
gate.

The comment step is skipped for exit 1 and 2, where `diff.md` is missing or partial and an ENOENT
from the upsert would bury the real failure.

## 5. The comment

One comment per pull request, found by the marker `<!-- aburi:diff-comment -->` and rewritten in
place, so a pushed branch does not accumulate a column of reports. A body identical to what is
already there is left alone (`unchanged`), which keeps a re-run from notifying everyone again.

A fork's pull request carries a read-only `GITHUB_TOKEN` regardless of the workflow's `permissions`
block, and so does Dependabot's — whose branch lives inside the repository and therefore passes any
`head.repo` check. Both need `comment: false`; the diff and the gate still run, and the report is
worth uploading as an artifact there, since that run is the one where nobody can read the comment.

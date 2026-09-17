# GitHub Action

The contract of `@aburi/github-action`: a composite action that runs `aburi diff` for a pull
request, posts the report as one comment it keeps rewriting, and fails the check when a
`--fail-on` gate trips.

See: [`cli-spec.md`](./cli-spec.md) §6.4 (`aburi diff`), §9 (exit codes), §6.7 (`--fail-on` grammar)
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
| `max-bytes` | *(empty)* | Forwarded to `--max-bytes`. Empty means 65507; `0` means no cap. §5.2. |
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

The upsert itself is [`scripts/upsert-comment.mjs`](https://github.com/kage1020/Aburi/blob/main/packages/github-action/scripts/upsert-comment.mjs),
a committed dependency-free script rather than an inline `actions/github-script` block, for the
reason the CLI resolver is a script too — it can be run in a test — and for one the resolver does
not have: a second caller runs it (§5.1), and an inline block cannot be called from a workflow.
Its input is environment only — `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `PR_NUMBER`, `MARKDOWN_PATH`,
and `GITHUB_API_URL` for Enterprise Server — because on a fork's pull request the Markdown names
symbols that pull request declares, and a body on a command line is one quoting mistake from being
run. `src/comment.ts` is the same flow as a library, for importers; `test/upsert-comment.test.ts`
pins the two to the same marker.

### 5.1 A pull request that cannot comment for itself

A fork's pull request carries a read-only `GITHUB_TOKEN` regardless of the workflow's `permissions`
block, and so does Dependabot's — whose branch lives inside the repository and therefore passes any
`head.repo` check. No input to this action changes that: `pull_request` decides the token's scope
before any step runs.

Widening it is the wrong fix. `pull_request_target` would run with a writable token in the base
repository's context, and `aburi diff` has to analyse the head — which on a fork is code the
contributor controls. The report is not worth handing out write access to produce.

So the work splits across two workflows, which is what this repository does:

| | Runs as | Does |
|---|---|---|
| [`aburi.yml`](https://github.com/kage1020/Aburi/blob/main/.github/workflows/aburi.yml) | `pull_request`, read-only on a fork | Analyses the head, gates the check, uploads `out/` as the `aburi-diff` artifact |
| [`aburi-comment.yml`](https://github.com/kage1020/Aburi/blob/main/.github/workflows/aburi-comment.yml) | `workflow_run`, base repository | Downloads that artifact and upserts the comment |

Three things make the second half safe to give a writable token:

1. **It executes nothing from the head.** It checks out the default branch, sparsely, for the
   upsert script alone, and reads the report as data.
2. **The pull request number comes from the event.** A fork's pull request can edit `aburi.yml`,
   and so decide what its run uploads; it cannot edit the head repository and branch GitHub
   records for that run. The number is resolved by listing open pull requests for
   `<head owner>:<head branch>` and matching `head.sha` — never read out of the artifact, which
   would let a crafted upload address a comment to a different pull request. When no open pull
   request is at that SHA the branch has moved on since the analysis ran, and a single open pull
   request on it is still unambiguous: it gets the report, one push stale, with a `::warning::` and
   a line at the top of the comment naming the commit it actually describes. Several, and none of
   them at that SHA, is a guess: the job fails rather than picking one.
3. **Nothing from the artifact is interpolated.** `${{ }}` of artifact content is pasted into the
   shell before bash sees it; the report reaches the script as a path in the environment.

The report body is still written by a run the contributor's branch configured, exactly as their
pull request description is. What the split buys is that this is the whole of their reach.

Which half comments is decided once, in `aburi.yml`, and travels in the artifact as a
`comment-pending` file. The companion posts when that file is there and exits when it is not. The
alternative — re-deriving the decision against a `workflow_run` payload — is a second copy that can
disagree with the first, and the way it disagrees is that nobody comments at all.

The decision is the **outcome**, not the permission: the marker is written when the analysis run
finished with no comment of its own, which is `comment-id` empty — the action was told not to post
(`CAN_COMMENT` false), or it tried and was refused. Keying on `CAN_COMMENT` alone would leave a
403, a rate limit or a `fetch failed` with no marker, and the companion would read that absence as
"a comment is already there" and say so in green, on a pull request that has none. The same test
gates the notice that run writes, so the two can never describe different runs, and the same
`cli-exit-code` arm as the action's own comment step keeps a partial report from being handed on.

Two properties of `workflow_run` are worth knowing before editing that file. GitHub runs the copy
on the **default branch**, so a change to it takes effect when it merges, not on the pull request
that makes it — and it produces **no check on the pull request**: the comment appearing is the
signal, and a failure shows up in the Actions tab.

`aburi-comment.yml` is this repository's own configuration rather than a template: its checkout
takes the upsert script from the repository the workflow lives in. A consumer's copy needs
`repository: kage1020/Aburi` and a pinned `ref:` on that step — which adds a line to the argument
above, since it runs third-party code in the privileged half — and
[`packages/github-action/README.md`](https://github.com/kage1020/Aburi/blob/main/packages/github-action/README.md)
carries that recipe. A consumer who does not want the second workflow at all can keep
`comment: false` on fork pull requests and read the report from the artifact; the diff and the gate
run either way.

### 5.2 The size the comment has to fit

GitHub rejects a comment body over **65536 bytes** with a 422 and posts nothing at all. The report
is roughly 210 bytes per symbol, so a pull request adding about 310 symbols reaches it — and the
run that loses its comment is the large refactor, the one most worth reading.

So the action renders the report to fit rather than discovering the ceiling at the API: it passes
`--max-bytes 65507`, which is the 65536-byte limit less the 29-byte marker line the upsert
prepends. The projection meets that by dropping whole sections, least important first, and says at
the top of the report which ones it dropped ([`markdown-projection.md`](./markdown-projection.md)
§6.4). `diff.json` is not capped: the artefact keeps everything the comment could not.

The budget is `ABURI_COMMENT_BODY_MAX_BYTES` in `src/comment.ts`, and `test/action-yml.test.ts`
holds the manifest's copy of the number to it — a marker of a different length moves the budget,
and a manifest still passing the old one is either 29 bytes short or 29 bytes over.

The decision lives in [`scripts/resolve-max-bytes.mjs`](https://github.com/kage1020/Aburi/blob/main/packages/github-action/scripts/resolve-max-bytes.mjs)
rather than in a branch inside the step, for the reason the CLI resolver does (§3.2): a `run:`
block is never executed by a test, so everything a test can say about one is spelling. Dropping a
guard from it would leave CI green and break every run — and the failure here is the quiet kind,
an oversized report and a comment that never posts. `test/resolve-max-bytes.test.ts` runs the
script as a process, against CLIs that do and do not carry the flag and one that cannot start.

Four details are deliberate:

- **The cap applies under `comment: false` too.** That is the mode a fork's pull request runs in
  (§5.1), where the Markdown travels as an artefact for the companion workflow to post. A cap that
  keyed on `comment` would leave that file oversized and move the 422 onto the one pull request
  whose author cannot see the companion's log.
- **The flag is probed for, not assumed.** `version` pins the CLI while this action is referenced
  by ref, so an older CLI under a newer action is the documented arrangement, and an option that
  CLI has never heard of would fail every such run at argv parsing. The script asks
  `aburi diff --help` first and, finding nothing, warns and renders uncapped — which is what that
  CLI did anyway. The warning names both upgrade routes, because `version` means nothing under
  `cli: workspace`.
- **A probe that could not run is not a missing flag.** A registry outage, a typo in `version`, an
  EACCES on the store and a CLI that crashes at startup all exit non-zero, and reporting them as
  "this CLI has no `--max-bytes`" would name a cause nothing established. They get their own
  warning, carrying the first line the probe wrote. The output is captured rather than piped into
  `grep`: `grep -q` closes the pipe at its first match, and a writer still going takes SIGPIPE,
  which under `pipefail` turns a successful match into a failed pipeline once the help text
  outgrows the pipe buffer.
- **`format: json` caps nothing.** That run writes no `diff.md`, so there is no document to fit
  and no reason to spend a probe. The CLI says the same thing from its end, with a warning rather
  than an error: the action passes the flag without consulting `format`, and an input error there
  would fail every `format: json` user.

Both ends of the upsert still measure before they write — `scripts/upsert-comment.mjs` with exit 2
and a one-line annotation, `upsertPullRequestComment` by throwing. Neither can re-render a finished
document, and cutting the string would post half a `<details>` block; what they can do is say which
file is how large, and which flag makes a smaller one, instead of relaying a 422 that never
mentions size.

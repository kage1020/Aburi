---
"@aburi/core": minor
"@aburi/cli": patch
---

Decide a component's languages over the files a scan would actually read

`Component.languages` is decided by counting file extensions in a component's subtree, and the
census carried its own eight-pattern exclusion list where discovery has twenty-six — and read no
`.gitignore` at all. A git-ignored tree, a vendored copy, or a previous run's `out/` was counted,
so a component could be labelled with a language no Symbol in it is written in. That label is in
the IR and is compared across revisions.

Detection now takes the same *drop* decision discovery takes: the shared core pattern list,
every directory's `.gitignore` under `config.respectGitignore`, and — from the caller that has
them — `config.ignore` and the loaded language plugins' file-drop globs.

Not the routing decision. The census still counts every extension it knows, whether or not a
plugin claims it and whatever `maxFileSizeBytes` says, because `Component.languages` answers
what a component is written in rather than what a run parsed (`component-detect.md` §4.4) — and
`aburi init` has to answer it before any plugin exists.

**A component's `languages` can change without the workspace changing.** A language whose files
were all excluded disappears from the list; a component left with nothing falls back to `ts`, as
it already did for an empty directory.

- `detectComponents` gains `ignore` and `respectGitignore`. `aburi scan` passes both; `aburi
  init` passes neither and gets `.gitignore` plus the core patterns, which is everything
  knowable before a config exists.
- The census is one walk from the workspace root, bucketed by component root, rather than one
  walk per root. `config.ignore` is workspace-root relative by contract and cannot be matched
  against a walk rooted inside a package — `packages/app/fixtures/**` matched nothing there, and
  `fixtures/**` would have matched every package's.
- `languageFileDropPatterns` is exported from `@aburi/core`; `CORE_IGNORE_PATTERNS` is shared
  between discovery and detection inside the package. Either way the two halves of a scan read
  one list rather than two that had already drifted.
- `aburi init` reads `.gitignore` now, so one it cannot use fails the command where before it
  could not. `init` gains `--respect-gitignore` / `--no-respect-gitignore`, and the failure
  names the flag — there is no config to turn it off in, since this command writes the first one.
- A failure while resolving components is no longer always exit 2. Detection walks the
  workspace and opens rule files, so an `EACCES` or an `EIO` from that walk is a runtime failure
  (exit 1); a component id or path the config cannot hold keeps exit 2.

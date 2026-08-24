---
"@aburi/core": minor
---

Read the `.gitignore` in every directory, the way git does

Discovery read one file — the workspace root's — so `packages/app/.gitignore` holding
`fixtures/` did nothing and those files were parsed into the IR. That is the ordinary way to
say a package's fixtures are not source, and the workspace was saying it to nobody.

Git consults a `.gitignore` in each directory from the repository root down to the file's own,
and the deepest file with an opinion decides — whichever direction it points. Twenty-eight
verdicts were measured against `git check-ignore` and are hardcoded as tests.

**This changes which files are in the IR, in both directions.** A package-local exclusion now
drops files, so a diff against an IR produced before this reports them as removed; a nested
`!` line now re-includes files, which appear as added. Neither is a change in the workspace —
run `aburi scan` on both sides before reading such a diff.

- A nested file's patterns are relative to its own directory: `/local.ts` in `packages/app`
  anchors to `packages/app/local.ts` and leaves `packages/app/sub/local.ts` alone.
- Nothing re-includes a file under a directory that was excluded, across files as within one:
  a root `gen/` cannot be undone by `gen/.gitignore` holding `!keep.ts`. A root `gen/*` can,
  because it never excluded the directory.
- `$GIT_DIR/info/exclude` and `core.excludesFile` are still not read, deliberately: both are
  per-machine, and the Document must not depend on who ran the scan. `.git/.gitignore` is not
  a rule file to git and is not one here.
- A `.gitignore` that is not a regular file is no patterns rather than a read failure that
  ended the run: a **directory** of that name, and a **symlink**, which git refuses to follow
  whether or not it resolves. Anything else that is not a regular file goes the same way,
  rather than blocking forever on a FIFO as git does.
- A `.gitignore` that exists as a regular file and cannot be *used* still ends the run, naming
  the file **and the line** — which is stricter than git's own warn-and-continue and is the
  point: a rule list that silently came up empty puts excluded files in the Document. Every
  rule is compiled when the file is read rather than when a candidate happens to reach it, so
  a pattern the regex engine refuses can no longer escape as a bare `SyntaxError` hundreds of
  files later, naming neither.
- Rule files are opened by descending to them, as git finds them. One under a directory with
  no surviving candidate — dropped by the Category A globs, excluded by an outer `.gitignore`,
  or inside `.git` — is never opened, so it can neither apply nor fail.

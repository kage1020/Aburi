---
"@aburi/cli": patch
---

Say which command and which output failed to write, and why a ref did not resolve

Two gaps in error surfacing, both in `aburi diff` and one shared with `aburi scan`.

**Output writes.** Config and IR reads were wrapped, but the write path was not: `aburi scan
--output-dir notadir` where `notadir` is a file answered `EEXIST: file already exists, mkdir
'…/notadir'` at exit 1, and a read-only output directory answered a bare `EPERM … open
'…/workspace.md'`. Nothing said which command was running or which of its outputs did not land.
Every artefact `init`, `scan`, `diff` and `explain` write — the output directory, the IR,
`workspace.md`, each component's Markdown, `diff.json`, `diff.md`, the config, the explain
Markdown — now goes through one path that reports `aburi <command> could not write <artefact> to
<path>: …`. The exit code follows who has to act: a path that cannot hold the output (a file
where the directory would go, a directory where the file would go) is exit 2 with the flag to
point elsewhere named — `--output-dir` or `output.dir` for the two directory-writing commands,
`--output` for the other two — and the errno kept after the sentence; a permission, a read-only
mount or a full disk stays exit 1, now with the command and artefact in front of Node's message
rather than instead of it. `aburi init` and `aburi explain` previously rethrew that second kind
raw; they now report it the same way. A refusal by the IR serializer itself (a document with two
keys differing only in Unicode composition) is still exit 2 and now says `serialize` rather than
`write`, since the disk was never asked.

**Ref resolution.** `aburi diff main..HEAD` in a directory that is not a git repository, and
`HEAD~1..HEAD` in a repository with no commits, both answered `Base ref 'main' could not be
resolved. If this is a CI shallow clone, run: git fetch --deepen=50 origin main` — advice that
cannot help either — at exit 1, which `cli-spec.md` reserves for the machine's failures. Git's own
stderr does not distinguish the cases (`Needed a single revision` for both a mistyped ref and an
empty repository), so once a ref fails the command asks git two more questions and says which it
was: `<cwd> is not inside a git repository` (with `--base/--head` as the way to compare without
one), `the repository at <cwd> has no commits yet`, or `no such revision in this repository.
Check the spelling` — with the `--deepen` remedy kept only when the clone actually is shallow. All
three are exit 2: what was typed, or where it was typed, is the reader's to fix. The probes run
only after a ref has failed, so a run whose refs resolve makes no extra git calls, and a probe
that itself fails answers "cannot tell" rather than replacing the failure it was explaining. A
missing `git` executable is still exit 1 with its own message.

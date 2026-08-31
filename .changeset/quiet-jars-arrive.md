---
"@aburi/cli": patch
---

Create the directories a single-file `--output` names

`aburi scan` and `aburi diff` have always created their `--output-dir` recursively. The two
commands whose output flag names a *file* — `aburi init --output` and `aburi explain --output` —
did not, so both of the examples the CLI reference hands the reader
(`--output config/aburi.jsonc`, `--output docs/alpha.md`) ended in Node's raw `ENOENT` at exit 1
in any tree that did not already hold those directories. The failure came after the whole run:
`init` had detected the workspace and `explain` had resolved and projected the Symbol, and both
threw the answer away on the last line.

Both write through one helper now, which creates the parent directories first. `aburi explain`
has three of those write sites — the id, file and pattern arms each project their own Markdown —
and each is reached by a different argument shape, so all three are covered rather than the one
the reported example happened to take.

What creation cannot get past is a path that cannot hold a file at all, and those are now the
input errors they are, at exit 2 rather than the exit 1 a raw errno produced. A recursive `mkdir`
is silent on a directory that already exists, so `EEXIST` from it is a non-directory standing
exactly where the parent belongs, and `ENOTDIR` is that same file further up the path; `EISDIR`
can only come from the write, which truncates rather than refusing an existing file, so it is the
`--output` itself naming a directory that is already there. All three are a statement about the
path the caller typed, which is the side of the line `cli-spec.md` §9 draws between exit 1 and
exit 2 — who has to act — and each message names the path and what to do about it. Every other
failure is rethrown untouched: a permission, a read-only mount or a full disk is not the reader's
to fix, and Node's own message already names the path.

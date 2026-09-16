---
"@aburi/markdown-projection": minor
"@aburi/github-action": minor
"@aburi/cli": minor
---

Render the report to the size a comment can hold, instead of learning it from a 422

`projectDiff` emitted whatever the diff was worth, and the document it produces exists to be
posted as a pull request comment — where GitHub's limit is 65536 bytes, enforced by rejecting
the whole body with a 422 and posting nothing. A minimal symbol renders at roughly 210 bytes, so
a branch adding about 310 symbols crossed it. The run that lost its report was the large refactor,
which is the one the report was for, and the failure named a status code rather than a size.

`projectDiff(diff, { maxBytes })` caps the document. It is met by dropping whole sections, not by
cutting the string: the sections are `<details>` blocks and fenced code, and a cut inside either
renders as an unclosed element swallowing the rest — a report that looks broken rather than
shortened, and says nothing about what is missing. Sections go in ascending order of importance,
which is the emission order read from the bottom (Syntax-only, then Dropped changes, then
Dependency changes, …), so what survives is always a prefix of it and an API change is never lost
while an implementation refactor stays. The title and the Summary line are never dropped. A capped
document says so directly under the Summary, naming the sections in the order the reader looked
for them:

```md
> ⚠ **2 sections were omitted** to keep this report within 65507 bytes: 💧 Dropped changes, 🎨 Syntax-only changes. The full report is the same diff rendered without a size cap.
```

`aburi diff --max-bytes <n>` is the CLI spelling, and it caps `diff.md` alone — `diff.json` is
unabridged, so nothing is lost from the artefact a tool reads.

The action passes `--max-bytes 65507` by default: the 65536-byte ceiling less the 29-byte marker
line the upsert prepends, kept in step with `ABURI_COMMENT_MARKER` by a test rather than spelled
twice. Two details are deliberate. The cap applies under `comment: false` as well, because that is
the mode a fork's pull request runs in, where the Markdown travels as an artefact for the
`workflow_run` companion to post — a cap keyed on `comment` would simply move the 422 onto the one
pull request whose author cannot see the companion's log. And the flag is probed for with
`aburi diff --help` rather than assumed, because `version` pins the CLI while the action is
referenced by ref: against an older CLI the action warns and renders uncapped, which is what that
CLI did anyway, instead of failing every run at argv parsing.

Both ends of the upsert now measure before they write — `scripts/upsert-comment.mjs` exits 2 with a
one-line annotation, `upsertPullRequestComment` throws — and say which file is how large and which
flag renders a smaller one. Neither can re-render a finished document, but neither relays a 422
that never mentions size. `GITHUB_COMMENT_MAX_BYTES` and `ABURI_COMMENT_BODY_MAX_BYTES` are
exported for callers posting Aburi reports themselves.

A section is the smallest unit the cap can drop, so a branch that adds two thousand symbols gets
the Summary line and the note rather than its first few hundred entries — the full report is in
`diff.json` and in an uncapped render. Trimming entries within a section is the obvious next step;
it is not a reason to keep posting nothing.

**Compatibility.** `projectDiff` takes the budget as a second argument and is unchanged without
one; every existing caller keeps the whole document. A workflow using the action does get a capped
`diff.md` where it previously got an uncapped one — that is the fix — and `max-bytes: 0` restores
the old behaviour for a run that wants the file whole.

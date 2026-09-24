---
"@aburi/markdown-projection": minor
"@aburi/cli": minor
---

A capped diff report lists a section's names before it drops the section

`projectDiff`'s `maxBytes` used to drop whole sections from the bottom, so the largest pull
requests got the emptiest reports: #290's kept only API changes and named none of its 302 removed
symbols. Sections are now kept most important first at their smallest — a section whose entries
are whole Symbols as one `name` *(kind)* — `file:line` row per Symbol — and one is dropped only
when it cannot fit even beside every more important one cut that far; the lists then get their
full entries back from the top as the budget allows. A section too large to fit even as names no
longer takes the smaller ones below it with it. The note tells the short sections apart from the
omitted ones, and says a budget was missed even when there was no section to drop.

`projectDiff` takes a `fullReportLocation` option naming where the uncapped report is; a line
break in it throws `RangeError`, and `maxBytes` is now checked before anything is rendered.
`aburi diff --max-bytes` writes that report as `diff.full.md`, before `diff.md`, whenever the cap
changed anything, and every other run — whatever its `--format` — removes one an earlier run left.
A path there that cannot be removed fails like one that cannot be written, with the artefact
named. `runDiff`'s report gains `diffFullMdPath`.

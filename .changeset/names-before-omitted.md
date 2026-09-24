---
"@aburi/markdown-projection": minor
"@aburi/cli": minor
---

A capped diff report lists a section's names before it drops the section

`projectDiff`'s `maxBytes` used to drop whole sections from the bottom, so the largest pull
requests got the emptiest reports: #290's kept only API changes and named none of its 302 removed
symbols. A section whose entries are whole Symbols now falls back to one
`name` *(kind)* — `file:line` row per Symbol before it is dropped, and the note tells the short
sections apart from the omitted ones. `projectDiff` takes a `fullReport` option naming where the
uncapped report is. `aburi diff --max-bytes` writes that report as `diff.full.md` whenever the cap
changed anything.

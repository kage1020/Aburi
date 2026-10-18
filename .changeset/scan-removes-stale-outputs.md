---
"@aburi/cli": patch
"@aburi/markdown-projection": patch
---

`aburi scan` now removes what an earlier run left in the output directory and this run does not write. A Component renamed or removed since loses its `components/<id>.md`; the old page used to stay beside the current ones, so anything reading `components/*.md` read a Component the IR no longer held. `--format json` (or `--no-md`) removes `workspace.md` and the component pages, and `--format md` (or `--no-json`) removes `aburi.ir.json`, which `aburi explain --no-rescan` used to answer from, finding a Symbol under the name it had before a rename. Only Aburi's own files go: a component page is a file named after a Component id whose first line is its `# Component: <id>` heading, so a README, notes or a subdirectory in `components/` stays. A path that cannot be removed is refused like one that cannot be written. A scan that stops before it writes, and the scan `aburi explain` runs when it finds no IR, remove nothing.

`@aburi/markdown-projection` exports `componentHeading`, the line a component page opens with.

The IR and the pages are unchanged, so an IR scanned before this release, compared with one scanned after, reports nothing it did not before.

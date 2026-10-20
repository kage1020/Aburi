---
"@aburi/cli": patch
"@aburi/markdown-projection": minor
---

`aburi scan` now removes what an earlier run left in the output directory and this run does not write. A Component renamed or removed since loses its `components/<id>.md`; the old page used to stay beside the current ones, so anything reading `components/*.md` read a Component the IR no longer held. `--format json` (or `--no-md`) removes `workspace.md` and the component pages, and `--format md` (or `--no-json`) removes `aburi.ir.json`, which `aburi explain --no-rescan` used to answer from, finding a Symbol under the name it had before a rename. `aburi.ir.json` and `workspace.md` are recognised by name alone, so a file of your own under either name goes too. In `components/` only Aburi's pages go: a page is a file named after a Component id whose first line is its `# Component: <id>` heading, so a README, notes or a subdirectory there stays.

Every removal comes after the run's last write, so a scan that stops before it has written everything removes nothing, and a `--format md` run that cannot write `workspace.md` keeps the earlier `aburi.ir.json`. A removal that fails ends the run with the files before it already removed; the next scan that completes removes the rest. A path that cannot be removed, a `components/` that cannot be listed and a page whose first line cannot be read are refused like a path that cannot be written, and the message names the step: `aburi scan could not list the components directory at …`, `could not read the Markdown for component "beta" at …`. A directory standing where an earlier run's file would be is described that way, by `aburi diff` too, rather than as one standing where the file would go. Only `aburi scan` removes anything: the scan `aburi explain` runs when it finds no IR, and `runScan` called with another `command`, remove nothing. `--log-level info` prints an `info: Removed <artefact> at <path>` line for each file removed, the discovered-vocabulary record a strict scan removes included.

`@aburi/markdown-projection` exports `componentHeading`, the line a component page opens with.

The IR and the pages are unchanged, so an IR scanned before this release, compared with one scanned after, reports nothing it did not before.

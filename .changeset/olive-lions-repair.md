---
"@aburi/cli": patch
---

A ref diff names the base worktree after the workspace, so a Component is not reported added and removed

`aburi diff <base>..<head>` materialised the base revision in a directory literally named
`base`. Component autodetection falls back to the directory name when no manifest declares one
(`component-detect.md` §4.1), so the base side of every diff was a Component called `base` while
the head side carried the project's real directory name — two ids for one workspace. A project
without a declared package name, or without explicit `components[]`, therefore got

```json
"summary": { "componentsAdded": 1, "componentsRemoved": 1 }
```

and a "Component changes / Added / Removed" section in `diff.md`, on a PR that changed nothing
structural. It reproduced on every run, which is the shape of a signal a reviewer learns to
scroll past.

The worktree is now created at `<temp>/base/<head-workspace-dirname>`, so the name detection
reads is the same on both sides. It sits under a directory of its own so the leaf is free to be
any name the head workspace has — including `base-out` and `head-out`, which as siblings would
be the run's own temporary output directories.

Nothing else about the temporary tree changes: it is still under `mkdtemp`, still removed in
`finally`, and the head is still the working tree whatever the ref spec calls it.

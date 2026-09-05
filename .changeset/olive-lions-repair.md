---
"@aburi/cli": patch
---

A ref diff names the base worktree after the workspace, so a Component is not reported added and removed

`aburi diff <base>..<head>` materialised the base revision in a directory literally named
`base`. Component autodetection falls back to the directory name for a Component rooted at the
workspace root (`component-detect.md` §4.1), so the base side of the diff was a Component called
`base` while the head side carried the project's real directory name — two ids for one workspace.
A workspace whose Component is the root itself, declaring neither a package name nor explicit
`components[]`, therefore got

```json
"summary": { "componentsAdded": 1, "componentsRemoved": 1 }
```

and a "Component changes / Added / Removed" section in `diff.md`, on a PR that changed nothing
structural. It reproduced on every run, which is the shape of a signal a reviewer learns to
scroll past. A Component under `packages/*` takes its name from its own directory and was never
affected, and either a declared package name or an explicit `components[]` was already enough to
immunise a project.

The worktree is now created at `<temp>/base/<head-workspace-dirname>` — the rule and its two
exceptions are `cli-spec.md` §6.4 step 2 — so the name detection reads is the same on both
sides. It sits under a directory of its own so the leaf is free to be any name the head
workspace has, including `base-out` and `head-out`, which as siblings would be the run's own
temporary output directories.

Cleanup no longer runs `git worktree remove` for a worktree that was never created: a failure
before the checkout existed used to report itself first as a cleanup failure advising `git
worktree prune`, ahead of the exception that actually ended the run.

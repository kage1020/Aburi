---
"@aburi/core": minor
"@aburi/cli": minor
---

A top-level file or directory whose name opens with one ASCII letter and a colon (`a:notes.ts`, `d:data/x.ts`) no longer ends the scan. A Document path reads that opening as a Windows drive, on every platform, so such a name has no spelling in the IR, and discovery handed it to the path rule anyway: `aburi scan` stopped with `path "a:notes.ts" is absolute; only workspace-relative paths are allowed`, exit 1, and wrote no IR. The file is now reported the way a name holding a backslash is: it is left out of the IR and of `stats.totalFiles`, the rest of the workspace is scanned and the IR written, and the run names it on stderr and exits 3.

```
⚠ 3 file(s) were left out of the IR and out of its counts, under 2 top-level name(s) a Document path reads as a Windows drive: a path opening with one ASCII letter and ":" names a drive there, and a Document means the same on every platform, so no workspace-relative path can open that way. Rename each one below, or leave it out with ignore, which matches the name as printed.
    a:notes.ts
    d:data — a directory, and the 2 file(s) under it
```

A colon anywhere else (`ab:notes.ts`, `src/x:y.ts`) is still an `unroutable` skip, as before. `ScanResult.unrepresentableFiles` (and `ScanReport.unrepresentableFiles`) can now hold `reason: "drive-shaped-name"`, with the top-level name in `unnameablePrefix`, beside `"unspellable-name"` and `"colliding-spelling"`; code that switches over that reason needs a case for it. `@aburi/core` exports `unnameableSite`, which says whether a path has no Document spelling, because of a backslash or a drive, and which prefix to rename. It no longer exports `backslashSite` or `BackslashSite`: `unnameableSite` answers the backslash case with the same prefix.

A workspace package in such a directory, or in one whose name holds a backslash, no longer ends the scan either: `pnpm-workspace.yaml` `packages: ["*"]` beside an `a:pkg/package.json`, or an nx `a:pkg/project.json`, stopped every `aburi scan` and `aburi init` with `pnpm workspace root "a:pkg" is absolute; … A package outside the workspace root cannot be described by this IR`, even with `components` declared in the config. That package is now not a Component and not on `workspace.managers[].roots`, and the other packages are detected as before. Both commands name it on stderr, whether or not it holds a source file, and `aburi scan` exits 3 for it, so an `aburi diff` whose scan found one exits 3 too:

```
⚠ pnpm package "a:pkg" (pnpm-workspace.yaml) is not a component and not on workspace.managers[].roots, and none of its files can be scanned: "a:pkg" opens with one ASCII letter and ":", which a Document path reads as a Windows drive, so no IR can name it. Rename it.
```

`aburi init` still writes the config and exits 0. Where that package was the only one, both commands follow the line with `No other workspace package was found, so the whole repository is described as one component.` `detectManagers` returns these packages as `unnameableRoots`, and `ScanReport` and `InitReport` carry them under the same name. A package under `..` is still refused as outside the workspace, whatever its name.

`aburi explain d:data/x.ts` and `aburi explain ./a:notes.ts`, and `aburi explain a:notes.ts` when that file exists, now answer, as a path holding a backslash does, that no IR can name the file and why, with exit 3, instead of `No matches` with exit 1. A bare argument that names no file, such as `A::create`, is still matched against qualified names.

Only a workspace holding such a name sees a difference, and it could not be scanned before, so there is no earlier IR of it to compare against. Every other IR is unchanged.

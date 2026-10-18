---
"@aburi/core": patch
"@aburi/config": patch
"@aburi/plugin-registry": patch
"@aburi/cli": patch
"@aburi/framework-next": patch
---

A JSON file that opens with a UTF-8 byte order mark is now read as it would be without one. Windows editors and PowerShell 5's `Out-File -Encoding utf8` write that mark, and Node's `require()`, npm and pnpm read past it, but Aburi handed it to the parser: a `package.json` that opened with one stopped `aburi scan` and `aburi init` with `Failed to parse JSON at <workspace>/package.json`, exit 1, and an `aburi.json` that did stopped `aburi scan` with `Config at <path> is not valid JSONC: InvalidSymbol at offset 0 (len 1)`, exit 2. One leading mark is now read past by component detection in a package's `package.json` or `project.json` and in the root `package.json` (`pnpm-workspace.yaml` already was); by the config loader in `aburi.json` and `aburi.jsonc`, which reports a repeated key at the column the editor shows; by `parsePluginManifest` and `loadPluginManifest`; and by `aburi diff --base/--head` and `aburi explain --ir` in an IR file. A second mark, or one anywhere but the start, is refused with the same error as before. `@aburi/core` exports the `stripUtf8Bom` it reads them with, and `@aburi/framework-next` now finds a module's `"use client"` through it, with no change in what it finds.

A repository with such a manifest could not be scanned before, so no stored IR of it changes. The one layout whose output moves is a tree with no `.git` below a `package.json` that declares `workspaces` and opens with a byte order mark: the root walk passed over that manifest, so the workspace root was the inner directory, and it is now the outer one, as it is without the mark. Every Symbol id and component root there gains the path between the two, so an IR scanned before this release, compared with one scanned after, reports those Symbols under new ids. Rescan the base rather than comparing against a stored IR. `aburi diff <base>..<head>` scans both sides with this release and is unaffected.

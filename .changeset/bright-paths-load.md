---
"@aburi/cli": patch
"@aburi/types": patch
---

Load a plugin named by absolute path on every platform

Only refs starting with `./` or `../` became `file:` URLs; everything else went to the ESM
resolver as a package specifier. On POSIX an absolute path contains `/`, so it passed through
verbatim and happened to import. On Windows it did not: `C:/plugins/x.mjs` failed with `Received
protocol 'c:'`, and `C:\plugins\x.mjs`, which contains no `/`, was prefixed into
`@aburi/C:\plugins\x.mjs`. The same `aburi.json` therefore loaded on one platform and exited 3 on
the other. An absolute path is now converted to a `file:` URL as well, and points at that file
whatever the workspace root is; on Windows it may be written with forward slashes or backslashes.

The conversion also fixes plugin file names containing `#` or `%` on every platform, POSIX
included: passed through verbatim, `#` began a URL fragment and `%` a percent-escape, so the file
was not found. Spaces were already fine.

On Windows a path rooted at a separator with no drive (`/opt/plugins/x.mjs`, `\plugins\x.mjs`)
counts as absolute to Node, but resolving it borrows the drive of the workspace root, so the same
ref could name a different file depending on where the workspace sits. Such a ref is refused with
exit 2 and a message asking for the drive letter, before anything is imported.

Relative paths are unchanged: they still have to start with `./` or `../`, and `.\plugins\x.mjs`
still resolves as a package name. The `@aburi/types` patch carries the regenerated `PluginRef`
description, which now names absolute paths.

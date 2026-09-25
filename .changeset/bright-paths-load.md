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
the other. An absolute path is now normalized and converted to a `file:` URL as well, and points
at that file whatever the workspace root is; on Windows it may be written with forward slashes or
backslashes, or name a UNC share.

The conversion also fixes plugin file names containing `#` or `%` on every platform, POSIX
included: passed through verbatim, `#` began a URL fragment and `%` a percent-escape, so the file
was not found. Spaces were already fine.

Refs that name a Windows drive in a way the platform cannot honour are now a config error, exit 2,
where they used to reach the ESM resolver and fail as a plugin load at exit 3:

- On Windows, a path rooted with no drive (`/opt/plugins/x.mjs`, `\plugins\x.mjs`) counts as
  absolute to Node but borrows a drive from elsewhere, and a drive with no root
  (`C:plugins\x.mjs`) resolves against whatever directory is current on that drive. Either could
  name a different file depending on where Aburi runs. The message spells the ref out with the
  workspace root's drive, or from the drive's root.
- On any other platform, a ref naming a drive (`C:/plugins/x.mjs`, `C:\plugins\x.mjs`) — a
  Windows-authored config read in WSL, a container or CI — is reported as naming a drive this
  platform does not have, instead of as an unknown URL scheme or `@aburi/` package.

Every ref is resolved before the first plugin is imported, so a refused ref stops the run before
any plugin code has run, including plugins listed ahead of it.

Relative paths are unchanged: they still have to start with `./` or `../`, and `.\plugins\x.mjs`
still resolves as a package name. The `@aburi/types` patch carries the regenerated `PluginRef`
description, which now names absolute paths.

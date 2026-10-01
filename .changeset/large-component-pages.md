---
"@aburi/markdown-projection": patch
"@aburi/cli": patch
---

`aburi scan` no longer crashes on a large component. The component page appended its whole Symbols section, and its boundary effect surface, with one `push(...lines)` call, and V8 overflows the stack past roughly 120,000 arguments: a component of about 11,000 Symbols with a few rules each (one ordinary repository of 1,500 files with no workspaces) ended the scan with `Maximum call stack size exceeded` and exit 1. The list of skipped files on `workspace.md` and a Slice's members on `diff.md` were appended the same way and failed at the same size. All four now append line by line, and render at 40,000 Symbols, 130,000 boundary Symbols, 130,000 skipped files and a 50,000-member Slice. `aburi scan` also writes `aburi.ir.json` before the Markdown pages, so a page that fails to render no longer costs the IR every page is derived from.

---
"@aburi/markdown-projection": patch
"@aburi/cli": patch
---

`aburi scan` no longer crashes on a large component. The component page appended its whole Symbols section, and its boundary effect surface, with one `push(...lines)` call, and V8 overflows the stack past roughly 120,000 arguments, so a page longer than that ended the scan with `Maximum call stack size exceeded` and exit 1. A Symbol with a few rules renders about 11 lines, so 11,000 of them were enough: a 1,500-file repository with no workspaces, so every Symbol lands in one component, reached it. The list of skipped files, the components table and the component dependency list on `workspace.md`, and a Slice's members on `diff.md`, were appended the same way. All six now append line by line.

`aburi scan` also writes `aburi.ir.json` before the Markdown pages, so a page that fails to render no longer costs the IR that every page is derived from, and an IR the serializer refuses leaves no pages beside it. A page that fails to render is reported as a bug in Aburi that names the page, and the scan's incidents are reported before the command ends.

---
"@aburi/markdown-projection": patch
---

Show a move within one file by its names and lines, not the same path twice

The diff counts any change of a Symbol's id as a move, so a rename or a new owner inside one file
is a move whose two paths are equal. `diff.md` printed it as `` `src/output-file.ts` → `src/output-file.ts` ``,
which read as a rendering bug and hid the one thing a reader needed: the name the Symbol had
before. It now reads `` within `src/output-file.ts`: `isADirectory` (L40) → `outputIsADirectory` (L60) ``
in the Moved + Changed entry, the folded Moved list and a Slice member's follow-up line, and a
names-only row ends ``(from `isADirectory` at L40)``. A move between files is unchanged.

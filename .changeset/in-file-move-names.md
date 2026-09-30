---
"@aburi/markdown-projection": patch
---

Show a move within one file by its names and lines, not the same path twice

The diff counts any change of id in a matched pair as a move, so a rename or a new owner inside
one file is a move whose two paths are equal. `diff.md` printed it as `` `src/output-file.ts` → `src/output-file.ts` ``,
which read as a rendering bug and hid the one thing a reader needed: the name the Symbol had
before. It now reads `` within `src/output-file.ts`: `isADirectory` (L40) → `outputIsADirectory` (L60) ``
in the Moved + Changed entry and the folded Moved list, which no longer opens with the head name
the route already gives. A names-only row ends ``(from `isADirectory` at L40)``.

A `moved+changed` Slice member's follow-up line now opens with its route, in either form, before
the delta axes it already listed: `` ↳ moved: `src/old.ts` → `src/new.ts`; delta.logicChanged ``.
It used to list the axes alone, so a member that had moved did not say so. A move between files
is otherwise unchanged.

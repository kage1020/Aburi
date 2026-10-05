---
"@aburi/markdown-projection": patch
---

A Symbol paired across a rename now shows its old name: every delta body of the pair opens with a `name` row, and a move between files gives each path with its name, in the Moved + Changed entry, the folded Moved list, a Slice member's follow-up line and the names-only row. A rename of the name's last segment explains the API flag, so the "no field-level detail" row no longer follows it.

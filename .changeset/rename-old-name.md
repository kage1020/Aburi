---
"@aburi/markdown-projection": patch
---

A Symbol paired across a change of name now shows its old name. Every delta body of a pair whose name changed opens with a `name` row; a move between files gives each path with its name in the Moved + Changed entry, the folded Moved list and a Slice member's follow-up line; and the pair's names-only rows say where it came from, `(from <old name> in <path>)` or `(from <old name> at L<line>)`, in API changes, Logic changes and Confidence changes as well as Moved + Changed, so the old name stays in the report whichever of those sections `--max-bytes` keeps. A change of the name's last segment explains the API flag, so the "no field-level detail" row no longer follows it.

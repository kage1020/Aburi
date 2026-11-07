---
"@aburi/diff": patch
---

`aburi diff` no longer ends with `RangeError: Maximum call stack size exceeded` when more than about 125,000 drop-listed Symbols on each side reach the dropped weak match, such as a generated or vendored tree that moved without git detecting the renames. The stage passed every pairing a key identified as one argument of a single call, which V8 caps; it now collects them without spreading.

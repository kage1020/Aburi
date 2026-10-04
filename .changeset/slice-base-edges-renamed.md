---
"@aburi/diff": patch
---

Slice View reads each base call edge in the ids its Nodes carry. A Symbol whose file was renamed (`moved+changed`, or `dropped-toggled` in a renamed file) used to lose every base-only edge from or to it, so a callee its caller stopped calling became a singleton. Such a Symbol now clusters through its base edges, as it does when the file keeps its name.

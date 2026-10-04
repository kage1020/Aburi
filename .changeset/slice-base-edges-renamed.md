---
"@aburi/diff": patch
---

Slice View reads each base call edge in the ids its Nodes carry. A Symbol whose id changed between the revisions (a `moved+changed` relocated to another file or renamed within its own, or a `dropped-toggled` matched under a new id) used to lose every base-only edge from or to it, so a callee its caller stopped calling became a singleton. Such a Symbol now clusters through its base edges, as it does when its id stays the same.

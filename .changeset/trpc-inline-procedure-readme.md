---
"@aburi/framework-trpc": patch
---

Document that a procedure written inside a router's object literal, still no Symbol of its own, is walked as part of the router: its resolver's calls, rules and effects are the router's.

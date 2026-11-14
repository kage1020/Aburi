---
"@aburi/core": minor
"@aburi/framework-trpc": minor
"@aburi/framework-express": patch
---

Name the middleware a tRPC procedure or base procedure runs: what each `.use(…)` on its own chain is handed and the builder each `.concat(…)` joins, in the order they run. Removing `.use(isAuthed)` from a procedure is now a logic change the report names (`middleware removed: isAuthed`) rather than a reformat, and swapping two is one with `reordered: true`. `@aburi/core` exports the naming framework-express used as `middlewareNames`, and both plugins name middleware through it.

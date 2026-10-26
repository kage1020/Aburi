---
"@aburi/framework-trpc": minor
"@aburi/cli": minor
"@aburi/effects-trpc": patch
---

New package `@aburi/framework-trpc` classifies the server side of tRPC as Boundaries: the `initTRPC` instance (`framework:trpc:instance`), routers and merged routers (`framework:trpc:router`), `query` / `mutation` / `subscription` procedures (`framework:trpc:procedure`), base procedures such as `t.procedure.use(isAuthed)` (`framework:trpc:base-procedure`) and middleware (`framework:trpc:middleware`), each a `const` whose own declarator holds the shape. Confidence is `high` in a file that imports `@trpc/server` and `medium` elsewhere. `aburi init` now writes `framework-trpc` for a workspace that depends on `@trpc/server`, where it used to report the framework as unmapped. The `@aburi/effects-trpc` README names the new package as the one that covers server-side routers.

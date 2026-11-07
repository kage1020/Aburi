---
"@aburi/types": minor
"@aburi/core": minor
"@aburi/effects-trpc": minor
"@aburi/effects-prisma": minor
"@aburi/effects-drizzle": minor
"@aburi/markdown-projection": minor
"@aburi/cli": minor
---

An effect plugin can now decline a call it recognises but cannot classify: `classify()` may return `{ declined: reason }` (`EffectDecline`) instead of `null`. A declined call that no later plugin classifies stays in `calls[]`, and the IR names it in the new `stats.declinedCalls` — plugin, owning Symbol, target, line and reason — so a call left unclassified on purpose can be told from one no plugin recognised. An empty or non-string reason fails the run with `scan-plugin-misconfigured`, and the integrity check refuses a `stats.declinedCalls` entry whose call its Symbol does not carry.

`@aburi/effects-trpc` declines the `query` terminal in a file that imports `@trpc/server` (`effects-plugin:trpc:server-file-query`), `@aburi/effects-prisma` declines `$queryRaw`, `$executeRaw` and the other raw-SQL methods (`effects-plugin:prisma:raw-query`), and `@aburi/effects-drizzle` declines `.execute(statement)` on a Drizzle client (`effects-plugin:drizzle:raw-sql`). `aburi explain` lists a Symbol's declines under `## Declined effects`.

---
"@aburi/effects-drizzle": minor
---

Add `@aburi/effects-drizzle`, a new effect plugin that classifies Drizzle ORM
call expressions into the core `db.read` / `db.write` / `db.transaction`
effect vocabulary.

### Recognised shapes

Two-signal join before returning an effect:

1. The file's import list must contain `drizzle-orm` or any driver subpath
   (`drizzle-orm/node-postgres`, `drizzle-orm/postgres-js`,
   `drizzle-orm/mysql2`, `drizzle-orm/better-sqlite3`,
   `drizzle-orm/bun-sqlite`, `drizzle-orm/neon-http`,
   `drizzle-orm/neon-serverless`, `drizzle-orm/d1`,
   `drizzle-orm/planetscale-serverless`, `drizzle-orm/libsql`,
   `drizzle-orm/vercel-postgres`, `drizzle-orm/xata-http`,
   `drizzle-orm/expo-sqlite`, ...). The gate is a **prefix match** rather than
   a closed allowlist because Drizzle ships new driver entry points per
   release. No import → `null` and control flows to the next effect plugin.
2. The trailing segments of `CallCandidate.target` must match Drizzle's public
   surface:
   - `<client>.select()` / `<client>.selectDistinct()` /
     `<client>.selectDistinctOn()` — root of a fluent query chain → `db.read`
   - `<client>.query.<table>.findMany` / `findFirst` — relational query API
     (4+ segments with `query` at index -3) → `db.read`
   - `<client>.insert(...)` / `<client>.update(...)` / `<client>.delete(...)` —
     root of a fluent write chain → `db.write`
   - `<client>.transaction(...)` / `<client>.batch(...)` (argCount ≥ 1) →
     `db.transaction` (`batch` covers the Neon / Cloudflare D1 multi-statement
     API which is semantically a transaction)

### Fluent-chain one-classification invariant

Drizzle is a fluent builder — `db.select().from(u).where(w).orderBy(o)` — where
the language plugin emits one CallCandidate per link (`db.select`,
`db.select.from`, `db.select.from.where`, ...). The classifier keeps
**one classification per chain** by rejecting any target whose internal
segments contain a fluent-root verb (`select` / `selectDistinct` /
`selectDistinctOn` / `insert` / `update` / `delete`). Only the 2-segment root
survives and is anchored to the query origin line, so a single SQL statement
produces exactly one effect record no matter how long its chain.

### Raw SQL

`.execute()` is deliberately **not** classified — a raw SQL call can be a
read or a write and static disambiguation would require SQL parsing (out of
scope). This mirrors how `@aburi/effects-prisma` treats `$queryRaw` /
`$executeRaw`.

### Manifest

`type: "effects"` with `xPrefix` deriving to `"drizzle"` from the package
name. `provides.effects` and `provides.effectPrefixes` are empty for v0.1 —
every classification returns core-owned `db.*` vocabulary, which
extension-vocab.md §5.1 forbids a plugin from declaring.
`derivedByPrefixes: ["effects-plugin:drizzle"]` owns the plugin-scoped
rationale so consumers can trace every effect back here.

### Public API

`drizzleEffectsPlugin` (ready-to-register instance), `DrizzleEffectsPlugin`
(class), `classifyDrizzleCall`, `hasDrizzleImport`, `effectsDrizzleManifest`,
the method-vocabulary constants (`DRIZZLE_READ_METHODS`,
`DRIZZLE_WRITE_METHODS`, `DRIZZLE_TRANSACTION_METHODS`,
`DRIZZLE_QUERY_METHODS`, `DRIZZLE_FLUENT_ROOT_METHODS`) with corresponding
type guards, plus types `DrizzleReadMethod`, `DrizzleWriteMethod`,
`DrizzleTransactionMethod`, `DrizzleQueryMethod`.

### Purity

`classify()` is a pure lookup — no I/O, no state, no async — matching the
per-call timeout budget the core enforces (effect-plugin.md §5.1.1).
Repeated invocations against the same CallCandidate produce identical
results, and the plugin holds no state across calls.

# @aburi/effects-drizzle

Drizzle ORM effect plugin for `@aburi/core`. Classifies Drizzle client calls
into core effect vocabulary so the IR can distinguish "reads the database"
from "writes the database" without needing to render every raw call.

Recognised shapes:

| Source shape | Effect |
|---|---|
| `<client>.select() / selectDistinct() / selectDistinctOn()` (root of a fluent chain) | `db.read` |
| `<client>.query.<table>.findMany / findFirst` (relational query API) | `db.read` |
| `<client>.insert(...) / update(...) / delete(...)` (root of a fluent chain) | `db.write` |
| `<client>.transaction(...) / batch(...)` | `db.transaction` |

### Fluent chain handling

Drizzle is a fluent builder — `db.select().from(u).where(w).orderBy(o)` — where
only the root call is the semantic anchor for the effect. The language plugin
emits one CallCandidate per link (`db.select`, `db.select.from`,
`db.select.from.where`, ...). The classifier keeps this a
**one-classification-per-chain** invariant by rejecting any target whose
internal segments contain a root verb (`select` / `selectDistinct` /
`selectDistinctOn` / `insert` / `update` / `delete`). Only the 2-segment root
survives and is anchored to the query origin line.

### Raw SQL

`.execute()` is intentionally **not** classified — a raw SQL call can be
either a read or a write, and statically distinguishing them would require SQL
parsing (out of the current scope). This mirrors how `@aburi/effects-prisma`
treats `$queryRaw` / `$executeRaw`.

### Layered gate

A file that imports `drizzle-orm` (or any driver subpath like
`drizzle-orm/postgres-js` / `drizzle-orm/node-postgres` / `drizzle-orm/d1` /
`drizzle-orm/neon-http` / ...) is a prerequisite. Files that only reference
identifiers like `db` without pulling in Drizzle are ignored, so an unrelated
`store.select(...)` (RxJS) or `router.delete(...)` (Express) will not
false-classify. The import gate uses a **prefix match** rather than a closed
allowlist because Drizzle publishes 20+ driver-specific subpaths and adds new
drivers per release.

## Install

```bash
pnpm add @aburi/effects-drizzle
```

## Usage

```ts
import { drizzleEffectsPlugin } from "@aburi/effects-drizzle"
```

## See also

- [`docs/design/effect-plugin.md`](../../docs/design/effect-plugin.md)

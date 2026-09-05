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

### Raw SQL and other unclassified surfaces

`.execute()` is intentionally **not** classified — a raw SQL call can be
either a read or a write, and statically distinguishing them would require SQL
parsing (out of the current scope). This mirrors how `@aburi/effects-prisma`
treats `$queryRaw` / `$executeRaw`.

`.$count()` and CTE builders (`db.with(sq).select().from(...)`) are also not
in the current vocab — the CTE case still works transparently because
`db.with.select` is the natural root of a fluent chain, but `$count` returns
null today. A future revision may add it as `db.read`.

### Layered gate

A file that imports `drizzle-orm` (or any driver subpath like
`drizzle-orm/postgres-js` / `drizzle-orm/node-postgres` / `drizzle-orm/d1` /
`drizzle-orm/neon-http` / ...) is a prerequisite. Files that never pull in
Drizzle are ignored outright. The import gate uses a **prefix match** rather
than a closed allowlist because Drizzle publishes 20+ driver-specific subpaths
and adds new drivers per release.

### Receiver identification

The import gate is not a receiver check: it answers "does this file use
Drizzle", and an Express router file is free to answer yes — Express + Drizzle
is one of the most common pairings there is, and `router.delete("/users/:id", h)`
has the same 2-segment shape as `db.delete(users)`. Three further checks decide
what is recorded:

- **Literal first argument.** A Drizzle root takes a table reference, a
  projection object, a callback or a statement array — never a bare literal. So
  `router.delete("/users/:id", handler)` and `store.select("name")` are not
  classified at all.
- **Receiver name.** The client segment — `db` in `db.select`, in
  `this.db.select` and in `db.query.users.findMany` — is matched word-wise
  against the client vocabulary (`drizzle` / `db` / `database` / `conn` /
  `connection` / `orm` / `tx` / `trx`), so `drizzleDb`, `readReplicaDb` and
  `_db` all count and `router`, `store`, `cache` and `httpClient` do not.
  `client` is deliberately absent: it would hand `httpClient.delete(url)` the
  top tier, which is the collision this check exists to catch.
- **Argument count.** Most roots take one argument; `selectDistinctOn(columns,
  projection)` and `transaction(callback, config)` take two, and the table in
  `src/methods.ts` says so. More than the terminal takes is evidence against —
  but only evidence: `argumentCount` is a syntactic count, and a drop would
  erase a real query without logging anything, so an overflow costs the tier
  instead.

A match on all three gives `confidence: "high"`; anything short of that still
records the effect, at `confidence: "medium"`.

The `medium` tier is deliberate. Without the AST — which effect plugins never
see — a client bound under a house naming convention and an unrelated object of
the same shape are indistinguishable from the callee string, so the uncertainty
is stated rather than resolved by guessing. A receiver the language plugin
flagged as dynamic (`getDb().select()`) is capped at `medium` for the same
reason: the name in the target is a collapsed expression, not a binding.

Naming your client something this vocabulary does not know is not an error — it
costs the effect its `high` tier, and the table in `src/receivers.ts` is one
literal list if a house convention deserves to be in it.

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

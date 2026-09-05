# @aburi/effects-prisma

Prisma effect plugin for `@aburi/core`. Classifies Prisma client calls into core
effect vocabulary so the IR can distinguish "reads the database" from "writes
the database" without needing to render every raw call.

Recognised shapes:

| Source shape | Effect |
|---|---|
| `<client>.<model>.findUnique / findUniqueOrThrow / findFirst / findFirstOrThrow / findMany / count / aggregate / groupBy` | `db.read` |
| `<client>.<model>.create / createMany / createManyAndReturn / update / updateMany / updateManyAndReturn / upsert / delete / deleteMany` | `db.write` |
| `<client>.$transaction(...)` | `db.transaction` |

Raw SQL (`$queryRaw` / `$executeRaw` / `$queryRawUnsafe` / `$executeRawUnsafe`)
is intentionally **not** classified today — statically distinguishing a read
raw query from a write raw query would require SQL parsing, which is out of the
current scope. A future revision may add it under a `medium` confidence tier.

Layered gate: a file that imports `@prisma/client` (or a re-export chain that
lands there) is a prerequisite, and the target must have at least three
`.`-separated segments (`<client>.<model>.<verb>`) so a random `foo.findMany()`
call in an unrelated file will not false-classify. Bare `$transaction()`
without a client segment is also skipped.

### Receiver identification

The import gate answers "does this file use Prisma", which a file is free to
answer yes to while most of its calls belong to something else. `delete`,
`create` and `update` are shared vocabulary across `Map`, `Set`, the DOM and
every HTTP router, and `this.<x>.<y>.delete(...)` is everyday TypeScript — so
the shape plus the gate is not evidence that the receiver is a database client.

Two further checks decide what is recorded:

- **Argument shape.** A Prisma delegate method takes one options object or
  nothing. A call with a literal first argument (`this.cache.items.delete("session")`)
  or a second argument is not a delegate call and is not classified at all.
- **Receiver name.** The segment before the model — `prisma` in
  `this.prisma.user.create`, `db` in `db.user.create` — is matched word-wise
  against the client vocabulary (`prisma` / `db` / `database` / `client` /
  `datasource` / `orm` / `tx` / `trx` / `transaction`), so `prismaClient`,
  `readReplicaDb` and `_prisma` all count and `cache`, `router` and `store` do
  not. A match gives `confidence: "high"`; anything else still records the
  effect, at `confidence: "medium"`.

The `medium` tier is deliberate. Without the AST — which effect plugins never
see — a client bound under a house naming convention and an unrelated object of
the same shape are indistinguishable from the callee string, so the uncertainty
is stated rather than resolved by guessing. A receiver the language plugin
flagged as dynamic (`getPrisma().user.create()`) is capped at `medium` for the
same reason: the name in the target is a collapsed expression, not a binding.

Naming your client something this vocabulary does not know is not an error — it
costs the effect its `high` tier, and the table in `src/receivers.ts` is one
literal list if a house convention deserves to be in it.

## Install

```bash
pnpm add @aburi/effects-prisma
```

## Usage

```ts
import { prismaEffectsPlugin } from "@aburi/effects-prisma"
```

## See also

- [`docs/design/effect-plugin.md`](../../docs/design/effect-plugin.md)

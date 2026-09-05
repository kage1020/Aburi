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

Three further checks decide what is recorded:

- **Literal first argument.** A Prisma method takes an options object, an array
  or a callback — never a bare literal. `this.cache.items.delete("session")` is
  a `Map`, and is not classified at all.
- **Receiver name.** The segment before the model — `prisma` in
  `this.prisma.user.create`, `db` in `db.user.create` — is matched word-wise
  against the client vocabulary (`prisma` / `db` / `database` / `orm` / `tx` /
  `trx`), so `prismaClient`, `readReplicaDb` and `_prisma` all count and
  `cache`, `router`, `store` and `apiClient` do not. `client` is deliberately
  absent: a resource SDK's `<client>.<resource>.<verb>` is a delegate call's
  shape exactly, so the entry would hand `apiClient.users.update(payload)` the
  top tier.
- **Argument count.** A delegate takes at most one argument, `$transaction`
  two. More than that is evidence against — but only evidence: `argumentCount`
  is a syntactic count, and a drop would erase a real write without logging
  anything, so an overflow costs the tier instead.

A match on all three gives `confidence: "high"`; anything short of that still
records the effect, at `confidence: "medium"`.

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

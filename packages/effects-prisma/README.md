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

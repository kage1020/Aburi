# @aburi/effects-prisma

Prisma effect plugin for `@aburi/core`. Classifies Prisma client calls into core
effect vocabulary so the IR can distinguish "reads the database" from "writes
the database" without needing to render every raw call.

Recognised shapes:

| Source shape | Effect |
|---|---|
| `prisma.<model>.findUnique / findFirst / findMany / count / aggregate / groupBy` | `db.read` |
| `prisma.<model>.create / createMany / update / updateMany / upsert / delete / deleteMany` | `db.write` |
| `prisma.$transaction(...)` | `db.transaction` |
| `prisma.$queryRaw / $executeRaw` | `db.write` (conservative — raw SQL cannot be statically distinguished) |

Layered gate: a file that imports `@prisma/client` (or a re-export chain that
lands there) is a prerequisite; a random `foo.findMany()` call in an unrelated
file will not false-classify.

## Install

```bash
pnpm add @aburi/effects-prisma
```

## Usage

```ts
import { prismaEffectsPlugin } from "@aburi/effects-prisma"
```

## See also

- [`design/details/effect-plugin.md`](../../design/details/effect-plugin.md)

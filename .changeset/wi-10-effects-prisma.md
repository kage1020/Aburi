---
"@aburi/effects-prisma": minor
---

Introduce `@aburi/effects-prisma`, the Prisma Client effect plugin. Recognizes model delegate calls (`prisma.<model>.<verb>`) and the top-level `prisma.$transaction` API, classifying them into the core `db.read` / `db.write` / `db.transaction` effect vocabulary.

### Recognition strategy

Two-signal join before returning an effect:

1. The file's import list must contain a Prisma Client module (currently `@prisma/client`). No import → `null` and control flows to the next effect plugin.
2. The trailing segments of `CallCandidate.target` must match Prisma's public surface:
   - `<...>.<model>.<verb>` — `<verb>` decides read (`findUnique`, `findFirst`, `findMany`, `count`, `aggregate`, `groupBy`, and their `-OrThrow` variants) or write (`create`, `createMany`, `createManyAndReturn`, `update`, `updateMany`, `updateManyAndReturn`, `upsert`, `delete`, `deleteMany`).
   - `<...>.$transaction` — the top-level transaction API.

Leading segments are irrelevant — `prisma.user.create`, `this.prisma.user.create`, and `container.services.prisma.user.create` all classify identically. Requiring three segments blocks two-segment false positives like Express's `router.create(...)` colocated with a Prisma import.

### Manifest

`type: "effects"` with `xPrefix` deriving to `"prisma"` from the package name. `provides.effects` and `provides.effectPrefixes` are empty for v0.1 — every classification returns core-owned `db.*` vocabulary, which extension-vocab.md §5.1 forbids a plugin from declaring. `derivedByPrefixes: ["effects-plugin:prisma"]` owns the plugin-scoped rationale so consumers can trace every effect back here.

### Public API

`prismaEffectsPlugin` (ready-to-register instance), `PrismaEffectsPlugin` (class), `classifyPrismaCall`, `hasPrismaImport`, `effectsPrismaManifest`, the method-vocabulary constants (`PRISMA_READ_METHODS`, `PRISMA_WRITE_METHODS`, `PRISMA_TRANSACTION_METHOD`) with corresponding type guards (`isPrismaReadMethod`, `isPrismaWriteMethod`, `isPrismaTransactionMethod`), plus types `PrismaReadMethod`, `PrismaWriteMethod`, `PrismaTransactionMethod`.

### Purity

`classify()` is a pure lookup — no I/O, no state, no async — matching the per-call timeout budget the core enforces (effect-plugin.md §5.1.1). Repeated invocations against the same CallCandidate produce identical results, and the plugin holds no state across calls.

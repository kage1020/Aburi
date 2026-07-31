---
"@aburi/cli": minor
"@aburi/core": minor
"@aburi/diff": minor
"@aburi/lang-typescript": minor
"@aburi/markdown-projection": minor
"@aburi/types": minor
"@aburi/config": patch
"@aburi/effects-drizzle": patch
"@aburi/effects-nest": patch
"@aburi/effects-prisma": patch
"@aburi/effects-trpc": patch
"@aburi/framework-express": patch
"@aburi/framework-nestjs": patch
"@aburi/framework-next": patch
"@aburi/framework-react": patch
"@aburi/plugin-registry": patch
---

Give `SymbolId`, `ComponentId`, and `SliceId` separate identities instead of three names for `string`.

Aburi mints three kinds of identifier and each owns a namespace, but all three were the
same type. `SymbolId` and `ComponentId` were bare aliases of `string`
(`aburi.ir.v1.json#/$defs/*` are `{"type": "string"}`, and json-schema-to-typescript
faithfully generates what the schema says); `SliceId` did not exist at all, so
`SliceRecord.id` was `string` and `SliceRecord.members` was `string[]`. Nothing stopped a
Component id being passed where a Symbol id was wanted, and `"slice:" + members[0]` — the
Slice-id derivation — was an expression any file could open-code, because its result was
assignable to the field it fed.

`SymbolId` and `ComponentId` are now nominal types, `SliceId` exists and is nominal too,
and `dependencies[].from` / `.to` are `SymbolId | ComponentId` rather than `string` — the
union is honest about the one array that holds both kinds, while still refusing an
arbitrary string. Every brand comes from a constructor: `makeSymbolId` / `trySymbolId` /
`makeComponentId` in `@aburi/core` and `sliceIdFor` in `@aburi/diff`. Assertions
(`x as SymbolId`) survive in four documented places and nowhere else — `packages/core/src/id.ts`,
`sliceIdFor` plus the untyped-input predicate in `packages/diff/src/slice.ts`, the single
`parsed as unknown as IR` in `readIR`, and per-package test fixtures, which need to be able
to write a malformed id for the cases that exist to reject one.

Two call sites were building Symbol ids by concatenation behind a type annotation and now
go through the constructor: the call-graph resolver and the LSP enrichment pass, which
assemble *speculative* callee ids and test them for existence. Those use `trySymbolId`, the
non-throwing variant — an id that cannot be built is a callee that cannot exist, which is
the same answer as a well-formed id absent from the Symbol table, so resolution behaviour is
unchanged. `@aburi/diff`'s git-rename stage, which rebuilds an id around a moved file path,
goes through the same constructor for the same reason.

The brands are TypeScript-only and erased at runtime. Scanning and diffing the
`nestjs-billing` fixture produces byte-identical `ir.json`, `diff.json`, `workspace.md`, and
`diff.md` before and after.

### Schema

`aburi.ir.v1.json` and `aburi.diff.v1.json` gain three `$defs` — `DependencyEndpoint`,
`SliceId`, and a loose `SymbolId` on the diff side — extracted verbatim from the inline
subschemas they replace. The validation semantics are identical; the change exists so the
generator has a named alias to attach a brand to. The brand itself is applied by a
post-processing pass in `packages/types/scripts/codegen-lib.ts`, not by a `tsType`-style
keyword in the schema: these are frozen v1 documents published for validators outside this
repository, and a non-standard keyword would make every strict-mode validator reject the
schema itself. That is the same reasoning that kept the Slice anchor keyword out of the file.

### Behaviour changes

Two, both for input that was already invalid:

- **`slice` is now a reserved language token.** Slice ids are `"slice:" + <anchor Symbol id>`,
  so a language plugin claiming `slice` would mint Symbol ids indistinguishable from Slice
  ids and make the derivation produce `slice:slice:…`. Branding cannot fix this — the strings
  are genuinely the same shape — so `makeSymbolId` rejects the token, and `checkIRIntegrity`
  rejects it in a document it did not build (new invariant #16). Only the whole token is
  reserved; `slicer` is still a legal language id. No plugin uses `slice` today.
- **Component detection fails loudly on an unusable id.** `detectComponents` derives the id
  by kebab-casing a package or directory name, and that transformation is not total: a name
  of only separators collapses to `""`, and one starting with a digit has no valid first
  character. Both are rejected by `aburi.ir.v1.json#/$defs/ComponentId`. They now raise
  `invalid-component-id` at detection time instead of landing in `components[].id` and
  producing an IR that fails its own schema with no indication of where the bad id came from.

### For plugin authors

`SymbolCandidate.id` and `OwnerSummary.id` are `SymbolId` rather than `string`. A language
plugin that already builds ids with `makeSymbolId` — as `@aburi/lang-typescript` does —
needs no change. One that concatenates the parts itself will stop type-checking and should
switch to the constructor, which enforces the `ir-schema.md` §3.1 grammar it was assuming.

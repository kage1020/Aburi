---
"@aburi/plugin-registry": minor
"@aburi/effects-prisma": minor
"@aburi/effects-nest": minor
"@aburi/effects-drizzle": patch
"@aburi/effects-trpc": patch
---

Hoist the language-plugin input guards into a shared
`@aburi/plugin-registry/plugin-input` surface and migrate every effect plugin onto
it.

### What moved

Two fail-fasts had been copied into all four effect plugins, and the copies had
drifted:

- `assertNonEmptySegments` — rejects a `CallCandidate.target` that is empty or has
  an empty `.`-separated segment. `effects-drizzle` / `effects-trpc` threaded the
  file path into the message; `effects-prisma` / `effects-nest` did not, and both
  returned their tuple through an `as unknown as` double cast.
- The `ImportEdge.source` check inside each `has*Import` — same split, with
  `effects-prisma` / `effects-nest` again omitting the file path and line.

Both now live in one implementation, parameterized by a `{ plugin, filePath }`
record so the message names the plugin that rejected the value and the file that
produced it.

### New public surface

`@aburi/plugin-registry/plugin-input` exports:

- `assertNonEmptySegments(target, origin)` → `{ segments, last }`. `segments` is a
  `readonly [string, ...string[]]` tuple built without a cast, and `last` hands
  classifiers the terminal segment so `parts.at(-1) as string` disappears from
  every call site.
- `hasMatchingImport(imports, origin, matches)` — validates every `ImportEdge`
  before matching, so throw behaviour never depends on import order. Folding the
  validation and the match into one function is what makes that ordering
  unforgeable: there is no way to ask "does this file import X?" while skipping
  the check. The predicate receives the module specifier alone.
- Types `NonEmptySegments`, `PluginInputOrigin`, `CallTargetSegments`.

It is a dedicated subpath rather than a barrel export because
`@aburi/plugin-registry`'s root compiles the plugin JSON Schema with ajv at module
scope — importing it from a classifier would put a full schema compilation on the
startup path of every effect plugin. The subpath chunk has no imports at all.

### Behaviour changes

- **`@aburi/effects-prisma` / `@aburi/effects-nest`**: throw messages now carry the
  source file (and, for import-edge violations, the line):
  `effects-prisma: CallCandidate.target is empty — …` becomes
  `effects-prisma (src/services/x.ts): CallCandidate.target is empty — …`.
  These errors are not caught by the core, so they reach the user; anything
  matching on the exact string needs updating.
- **`hasPrismaImport` / `hasNestEmitterImport` now require a second `filePath`
  argument**, matching `hasDrizzleImport` / `hasTrpcClientImport`. The path is
  what makes the thrown message actionable, so it is required rather than
  optional.
- **`@aburi/effects-drizzle` / `@aburi/effects-trpc`**: no observable change —
  messages and signatures are byte-identical to before.

Each plugin also gained a leaf `constants.ts` holding its name and `derivedBy`
prefix, which removes the `manifest.ts → classify.ts` import edge and keeps the
name the manifest declares identical to the one the guards print. The plugin-name
constants (`EFFECTS_PRISMA_PLUGIN_NAME` and siblings) are exported alongside the
existing `EFFECTS_*_DERIVED_BY_PREFIX` values.

The normalized-callee contract these guards enforce — non-empty `target`, no empty
segments, non-empty `ImportEdge.source` — is now written down in
`docs/design/lang-plugin.md` §4.4 instead of living only in four copies of a
comment.

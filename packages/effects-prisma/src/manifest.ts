import type { EffectsManifest } from "@aburi/types"

/**
 * Manifest for `@aburi/effects-prisma`. `as const satisfies EffectsManifest` keeps
 * every literal narrow so downstream registry checks and template-literal validators
 * see the exact shape.
 *
 * The plugin returns core-owned effect ids (`db.read` / `db.write` / `db.transaction`)
 * from `classify()`; per extension-vocab.md §9.1 core vocab is registered by the core
 * engine itself and MUST NOT appear in a plugin's `provides.effects`. The plugin's own
 * namespace (`x-prisma`, derived from the `effects-` stripped name) has no v0.1
 * bindings — Prisma model-specific effects would sit under `x-prisma:*` once introduced.
 * `derivedByPrefixes` carries the plugin-scoped rationale prefix so consumers can trace
 * every effect back to this plugin without matching against the core vocab.
 */
export const effectsPrismaManifest = {
  $schema: "https://aburi.dev/schema/aburi.plugin.v1.json",
  name: "effects-prisma",
  version: "0.0.0",
  type: "effects",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: [],
    extKindPrefixes: [],
    derivedByPrefixes: ["effects-plugin:prisma"],
    frameworks: [],
  },
} as const satisfies EffectsManifest

import type { PluginManifest, Provides } from "@aburi/types"

interface ManifestOverrides {
  name?: string
  provides?: Partial<Provides>
}

const SCHEMA = "https://aburi.kage1020.com/schema/aburi.plugin.v1.json" as const

function provides(over: Partial<Provides> = {}): Provides {
  return {
    effects: [],
    effectPrefixes: [],
    extKinds: [],
    extKindPrefixes: [],
    derivedByPrefixes: [],
    frameworks: [],
    ...over,
  }
}

export function langManifest(over: ManifestOverrides = {}): PluginManifest {
  return {
    $schema: SCHEMA,
    name: over.name ?? "lang-foo",
    version: "1.0.0",
    type: "lang",
    engines: { aburi: "^1.0.0" },
    provides: provides(over.provides),
  }
}

export function effectsManifest(
  over: ManifestOverrides & { xPrefix?: string } = {},
): PluginManifest {
  return {
    $schema: SCHEMA,
    name: over.name ?? "effects-foo",
    version: "1.0.0",
    type: "effects",
    ...(over.xPrefix !== undefined ? { xPrefix: over.xPrefix } : {}),
    engines: { aburi: "^1.0.0" },
    provides: provides(over.provides),
  }
}

export function frameworkManifest(over: ManifestOverrides = {}): PluginManifest {
  return {
    $schema: SCHEMA,
    name: over.name ?? "framework-foo",
    version: "1.0.0",
    type: "framework",
    engines: { aburi: "^1.0.0" },
    provides: provides(over.provides),
  }
}

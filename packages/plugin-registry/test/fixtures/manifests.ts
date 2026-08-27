import type { PluginManifest } from "@aburi/types"

// Helpers to build minimally-valid PluginManifest objects for registry tests.
// Each helper returns a fresh object so individual tests can mutate without
// affecting siblings.

interface BaseOverrides {
  name?: string
  version?: string
}

const SCHEMA = "https://aburi.kage1020.com/schema/aburi.plugin.v1.json" as const
const ENGINES = { aburi: "^1.0.0" } as const

function emptyProvides() {
  return {
    effects: [],
    effectPrefixes: [],
    extKinds: [],
    extKindPrefixes: [],
    derivedByPrefixes: [],
    frameworks: [],
  }
}

export function langManifest(over: BaseOverrides = {}): PluginManifest {
  return {
    $schema: SCHEMA,
    name: over.name ?? "lang-foo",
    version: over.version ?? "1.0.0",
    type: "lang",
    engines: { ...ENGINES },
    provides: emptyProvides(),
  }
}

export function effectsManifest(over: BaseOverrides & { xPrefix?: string } = {}): PluginManifest {
  const name = over.name ?? "effects-foo"
  return {
    $schema: SCHEMA,
    name,
    version: over.version ?? "1.0.0",
    type: "effects",
    ...(over.xPrefix !== undefined ? { xPrefix: over.xPrefix } : {}),
    engines: { ...ENGINES },
    provides: emptyProvides(),
  }
}

export function frameworkManifest(over: BaseOverrides = {}): PluginManifest {
  return {
    $schema: SCHEMA,
    name: over.name ?? "framework-foo",
    version: over.version ?? "1.0.0",
    type: "framework",
    engines: { ...ENGINES },
    provides: emptyProvides(),
  }
}

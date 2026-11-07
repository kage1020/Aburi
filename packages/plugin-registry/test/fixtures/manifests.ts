import { PLUGIN_SCHEMA_URL, type PluginManifest, type Provides } from "@aburi/types"

interface ManifestOverrides {
  name?: string
  provides?: Partial<Provides>
}

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

export function langManifest(
  over: ManifestOverrides & { languageId?: string } = {},
): PluginManifest {
  return {
    $schema: PLUGIN_SCHEMA_URL,
    name: over.name ?? "lang-foo",
    version: "1.0.0",
    type: "lang",
    languageId: over.languageId ?? "foo",
    engines: { aburi: "^1.0.0" },
    provides: provides(over.provides),
  }
}

export function effectsManifest(
  over: ManifestOverrides & { xPrefix?: string } = {},
): PluginManifest {
  return {
    $schema: PLUGIN_SCHEMA_URL,
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
    $schema: PLUGIN_SCHEMA_URL,
    name: over.name ?? "framework-foo",
    version: "1.0.0",
    type: "framework",
    engines: { aburi: "^1.0.0" },
    provides: provides(over.provides),
  }
}

import { makeLanguageId } from "@aburi/core"
import {
  type EffectPlugin,
  type EffectsManifest,
  type FrameworkManifest,
  type LangManifest,
  type LanguagePlugin,
  PLUGIN_SCHEMA_URL,
  type PluginManifest,
} from "@aburi/types"

const FAKE_MANIFEST = {
  $schema: PLUGIN_SCHEMA_URL,
  version: "0.0.0",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: [],
    extKindPrefixes: [],
    derivedByPrefixes: [],
    frameworks: [],
  },
} as const satisfies Omit<PluginManifest, "name" | "type">

export const LANG_MANIFEST: LangManifest = {
  ...FAKE_MANIFEST,
  name: "lang-fake",
  type: "lang",
  languageId: makeLanguageId("fake"),
}

export const EFFECTS_MANIFEST: EffectsManifest = {
  ...FAKE_MANIFEST,
  name: "effects-fake",
  type: "effects",
  provides: { ...FAKE_MANIFEST.provides, derivedByPrefixes: ["effects-plugin:fake"] },
}

export const FRAMEWORK_MANIFEST: FrameworkManifest = {
  ...FAKE_MANIFEST,
  name: "framework-fake",
  type: "framework",
}

/** The source of a plugin module: `members` is JavaScript for the fields beside `manifest`. */
export function pluginModuleSource(manifest: PluginManifest, members: string): string {
  return `export const plugin = {
  manifest: ${JSON.stringify(manifest)},
${members}
}
`
}

export const FAKE_LANGUAGE_PLUGIN: LanguagePlugin = {
  manifest: LANG_MANIFEST,
  fileExtensions: [".fake"],
  capabilities: {
    hasDecorators: false,
    hasGenerics: false,
    hasAsync: false,
    hasMacros: false,
    hasPatternMatching: false,
    hasAbstractTypes: false,
    hasModules: false,
    hasNamespaces: false,
    hasTypeParameters: false,
    hasExplicitVisibility: false,
    hasJsDoc: false,
  },
  init: async () => {},
  parseFile: async () => ({ tree: {}, errors: [], imports: [] }),
  extractSymbols: () => [],
  walkBody: () => ({ rules: [], calls: [] }),
  normalizeAst: () => "",
}

export const FAKE_EFFECTS_PLUGIN: EffectPlugin = {
  manifest: EFFECTS_MANIFEST,
  init: async () => {},
  classify: () => null,
}

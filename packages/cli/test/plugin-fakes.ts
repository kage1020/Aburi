import { makeLanguageId } from "@aburi/core"
import type {
  EffectPlugin,
  EffectsManifest,
  FrameworkManifest,
  LangManifest,
  LanguagePlugin,
  PluginManifest,
} from "@aburi/types"

export const LANG_MANIFEST: LangManifest = {
  $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
  name: "lang-fake",
  version: "0.0.0",
  type: "lang",
  engines: { aburi: "*" },
  provides: {
    effects: [],
    effectPrefixes: [],
    extKinds: [],
    extKindPrefixes: [],
    derivedByPrefixes: [],
    frameworks: [],
  },
}

export const EFFECTS_MANIFEST: EffectsManifest = {
  ...LANG_MANIFEST,
  name: "effects-fake",
  type: "effects",
  provides: { ...LANG_MANIFEST.provides, derivedByPrefixes: ["effects-plugin:fake"] },
}

export const FRAMEWORK_MANIFEST: FrameworkManifest = {
  ...LANG_MANIFEST,
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
  languageId: makeLanguageId("fake"),
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

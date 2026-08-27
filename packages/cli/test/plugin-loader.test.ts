import type {
  Config,
  EffectPlugin,
  EffectsManifest,
  LangManifest,
  LanguagePlugin,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import { CliError, loadPlugins } from "../src"

const langManifest: LangManifest = {
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

const effectsManifest: EffectsManifest = {
  ...langManifest,
  name: "effects-fake",
  type: "effects",
  provides: {
    ...langManifest.provides,
    derivedByPrefixes: ["effects-plugin:fake"],
  },
}

const fakeLangPlugin: LanguagePlugin = {
  manifest: langManifest,
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
} as unknown as LanguagePlugin

const fakeEffectsPlugin: EffectPlugin = {
  manifest: effectsManifest,
  init: async () => {},
  classify: () => null,
} as EffectPlugin

describe("loadPlugins — module resolution and bucketing", () => {
  it("loads a language plugin from a named export and buckets it", async () => {
    const config: Config = { languages: ["lang-fake"] }
    const loaded = await loadPlugins({
      config,
      workspaceRoot: "/tmp",
      importModule: async () => ({ langFakePlugin: fakeLangPlugin }),
    })
    expect(loaded.languages).toHaveLength(1)
    expect(loaded.frameworks).toHaveLength(0)
    expect(loaded.effects).toHaveLength(0)
    expect(loaded.registry.listPlugins().map((p) => p.name)).toContain("lang-fake")
  })

  it("prefers `default` export when present", async () => {
    let picked: unknown = null
    const config: Config = { effects: ["effects-fake"] }
    const loaded = await loadPlugins({
      config,
      workspaceRoot: "/tmp",
      importModule: async () => ({
        default: fakeEffectsPlugin,
        somethingElse: { manifest: { name: "other", type: "effects" } },
      }),
    })
    picked = loaded.effects[0]
    expect(picked).toBe(fakeEffectsPlugin)
  })

  it("rejects a plugin whose manifest type disagrees with its bucket", async () => {
    const config: Config = { effects: ["lang-fake"] }
    await expect(
      loadPlugins({
        config,
        workspaceRoot: "/tmp",
        importModule: async () => ({ langFakePlugin: fakeLangPlugin }),
      }),
    ).rejects.toBeInstanceOf(CliError)
  })

  it("throws when the module has no export with a manifest", async () => {
    const config: Config = { languages: ["lang-fake"] }
    await expect(
      loadPlugins({
        config,
        workspaceRoot: "/tmp",
        importModule: async () => ({ hello: 1 }),
      }),
    ).rejects.toThrow(/no export carrying a `manifest`/)
  })

  it("routes framework hint synthetic manifests into the registry", async () => {
    const config: Config = {}
    const loaded = await loadPlugins({
      config,
      workspaceRoot: "/tmp",
      importModule: async () => ({}),
      syntheticPlugins: [
        {
          ...effectsManifest,
          name: "framework-hint-fake",
          type: "framework",
          provides: { ...effectsManifest.provides, derivedByPrefixes: [] },
        },
      ],
    })
    expect(loaded.registry.listPlugins().map((p) => p.name)).toContain("framework-hint-fake")
  })

  it("resolves bare manifest names to @aburi/<name>", async () => {
    const config: Config = { languages: ["lang-fake"] }
    let seen = ""
    await loadPlugins({
      config,
      workspaceRoot: "/tmp",
      importModule: async (specifier) => {
        seen = specifier
        return { plugin: fakeLangPlugin }
      },
    })
    expect(seen).toBe("@aburi/lang-fake")
  })

  it("treats scope-prefixed refs as verbatim package ids", async () => {
    const config: Config = { languages: ["@aburi/lang-typescript"] }
    let seen = ""
    await loadPlugins({
      config,
      workspaceRoot: "/tmp",
      importModule: async (specifier) => {
        seen = specifier
        return { plugin: fakeLangPlugin }
      },
    })
    expect(seen).toBe("@aburi/lang-typescript")
  })

  it("resolves relative refs against the workspace root as file URLs", async () => {
    const config: Config = { languages: ["./plugins/local.mjs"] }
    let seen = ""
    await loadPlugins({
      config,
      workspaceRoot: "/tmp/proj",
      importModule: async (specifier) => {
        seen = specifier
        return { plugin: fakeLangPlugin }
      },
    })
    expect(seen).toMatch(/^file:.*plugins\/local\.mjs$/)
  })
})

import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import type {
  Config,
  EffectPlugin,
  EffectsManifest,
  LangManifest,
  LanguagePlugin,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import { CliError, loadPlugins } from "../src"
import { STUB_PLUGIN } from "./stub-language"

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

  const absolutePath = resolve(tmpdir(), "aburi plugins", "local #100%.mjs")
  it.each([
    ...new Set([absolutePath, absolutePath.replaceAll("\\", "/")]),
  ])("resolves the absolute ref %s as a file URL independently of the plugin root", async (ref) => {
    let seen = ""
    await loadPlugins({
      config: { languages: [ref] },
      workspaceRoot: resolve(tmpdir(), "workspace"),
      pluginRefRoot: resolve(tmpdir(), "different-plugin-root"),
      importModule: async (specifier) => {
        seen = specifier
        return { plugin: fakeLangPlugin }
      },
    })
    expect(seen).toBe(pathToFileURL(absolutePath).href)
  })

  it("keeps explicit file URLs unchanged", async () => {
    const ref = pathToFileURL(absolutePath).href
    let seen = ""
    await loadPlugins({
      config: { languages: [ref] },
      workspaceRoot: tmpdir(),
      importModule: async (specifier) => {
        seen = specifier
        return { plugin: fakeLangPlugin }
      },
    })
    expect(seen).toBe(ref)
  })

  it("imports an absolute plugin path containing spaces and URL-special characters", async () => {
    const scratch = await mkdtemp(resolve(tmpdir(), "aburi-plugin-path-"))
    try {
      const pluginPath = resolve(scratch, "local #100%.mjs")
      await writeFile(pluginPath, STUB_PLUGIN, "utf8")
      // Use Node's ESM loader directly: Vitest's module runner treats URL fragments differently.
      const loaderUrl = new URL("../src/plugin-loader.ts", import.meta.url).href
      const { stdout } = await promisify(execFile)(process.execPath, [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import { loadPlugins } from ${JSON.stringify(loaderUrl)};
        const loaded = await loadPlugins(${JSON.stringify({
          config: { languages: [pluginPath] },
          workspaceRoot: resolve(scratch, "workspace"),
        })});
        console.log(JSON.stringify(loaded.languages.map(plugin => plugin.manifest.name)));`,
      ])
      expect(JSON.parse(stdout)).toEqual(["lang-stub"])
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})

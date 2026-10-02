import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { frameworkHintPlugins } from "@aburi/config"
import { makeLanguageId } from "@aburi/core"
import { RegistryError } from "@aburi/plugin-registry"
import type {
  Config,
  EffectPlugin,
  EffectsManifest,
  FrameworkPlugin,
  LangManifest,
  LanguagePlugin,
} from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CliError, EXIT, loadPlugins, runCli } from "../src"
import { detectorIdRefusal, windowsDriveRefusal } from "../src/plugin-loader"
import { MemStream } from "./fixtures"
import { populate, STUB_PLUGIN } from "./stub-language"

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

const fakeEffectsPlugin: EffectPlugin = {
  manifest: effectsManifest,
  init: async () => {},
  classify: () => null,
}

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

  it("registers a frameworkHints plugin under framework:hint and runs it after the configured frameworks", async () => {
    const fakeFramework: FrameworkPlugin = {
      manifest: { ...langManifest, name: "framework-fake", type: "framework" },
      init: async () => {},
      classifySymbol: () => null,
    }
    const loaded = await loadPlugins({
      config: { frameworks: ["framework-fake"] },
      workspaceRoot: "/tmp",
      importModule: async () => ({ plugin: fakeFramework }),
      syntheticPlugins: frameworkHintPlugins({
        frameworkHints: [
          {
            name: "acme",
            decorators: { AcmeController: { extKind: "framework:acme:controller" } },
          },
        ],
      }),
    })
    expect(loaded.frameworks.map((p) => p.manifest.name)).toEqual(["framework-fake", "hint-acme"])
    expect(loaded.registry.findExtKind("framework:hint:acme:controller")?.owner.name).toBe(
      "hint-acme",
    )
  })

  it("reports a frameworkHints entry the registry refuses as a config error naming the entry", async () => {
    // Both entries write the vendor `acme`, so both derive `framework:hint:acme` (config.md §8.4).
    const error = await loadPlugins({
      config: {},
      workspaceRoot: "/tmp",
      importModule: async () => ({}),
      syntheticPlugins: frameworkHintPlugins({
        frameworkHints: [
          { name: "acme", decorators: { A: { extKind: "framework:acme:a" } } },
          { name: "acme-two", decorators: { B: { extKind: "framework:acme:b" } } },
        ],
      }),
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).code).toBe("config-error")
    expect((error as CliError).message).toContain(`frameworkHints entry "acme-two"`)
    expect((error as CliError).cause).toBeInstanceOf(RegistryError)
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

  async function specifierFor(ref: string): Promise<string> {
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
    return seen
  }

  // On POSIX `absolutePath` is `/tmp/…`, rooted with no drive, which Windows refuses: this case
  // also fails if the Windows-only refusal ever stops checking the platform.
  it("resolves an absolute ref to its own location, not under the plugin ref root", async () => {
    expect(await specifierFor(absolutePath)).toBe(pathToFileURL(absolutePath).href)
  })

  // `C:/plugins/x.mjs` is what people write in JSON to avoid escaping backslashes. On POSIX
  // `absolutePath` has no backslash, so this case would be the one above.
  it.runIf(process.platform === "win32")(
    "resolves a Windows absolute ref written with forward slashes",
    async () => {
      expect(await specifierFor(absolutePath.replaceAll("\\", "/"))).toBe(
        pathToFileURL(absolutePath).href,
      )
    },
  )

  it.runIf(process.platform === "win32").each(["//server/share/x.mjs", "\\\\server\\share\\x.mjs"])(
    "resolves the UNC ref %s to a file URL on the share",
    async (ref) => {
      expect(await specifierFor(ref)).toBe("file://server/share/x.mjs")
    },
  )

  it("resolves a backslash relative ref as a package name, since only ./ and ../ mark a path", async () => {
    expect(await specifierFor(".\\plugins\\x.mjs")).toBe("@aburi/.\\plugins\\x.mjs")
  })

  it("refuses a Windows-drive ref before importing any plugin, even one listed earlier", async () => {
    // A ref each platform refuses: driveless on Windows, a drive letter anywhere else.
    const refused = process.platform === "win32" ? "/opt/plugins/x.mjs" : "C:/plugins/x.mjs"
    const imported: string[] = []
    const error = await loadPlugins({
      config: { languages: ["./plugins/ok.mjs"], effects: [refused] },
      workspaceRoot: tmpdir(),
      importModule: async (specifier) => {
        imported.push(specifier)
        return { plugin: fakeLangPlugin }
      },
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).code).toBe("config-error")
    expect((error as CliError).message).toContain(`Plugin "${refused}"`)
    expect(imported).toEqual([])
  })

  it("refuses a bare id before importing any plugin, even one listed earlier", async () => {
    const imported: string[] = []
    const error = await loadPlugins({
      config: { languages: ["lang-fake"], effects: ["prisma"] },
      workspaceRoot: tmpdir(),
      importModule: async (specifier) => {
        imported.push(specifier)
        return { plugin: fakeLangPlugin }
      },
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).code).toBe("config-error")
    expect((error as CliError).message).toContain(
      `Plugin "prisma" in "effects" is not a plugin name: a bare name resolves to "@aburi/prisma"`,
    )
    expect((error as CliError).message).toContain('Write "effects-prisma".')
    expect(imported).toEqual([])
  })

  describe("detectorIdRefusal", () => {
    it.each([
      ["languages", "tsx", 'Write "lang-typescript".'],
      ["frameworks", "nextjs", 'Write "framework-next".'],
      ["frameworks", "vue", "Write the plugin's manifest name"],
      ["effects", "nestjs", 'Write "effects-nestjs".'],
      ["languages", "x", "Write the plugin's manifest name"],
    ] as const)("refuses %s: %s", (field, ref, fix) => {
      expect(detectorIdRefusal(ref, field)).toContain(fix)
    })

    it("suggests a plugin of the field's own kind", () => {
      expect(detectorIdRefusal("nestjs", "effects")).not.toContain("framework-nestjs")
    })

    it.each([
      "lang-typescript",
      "@aburi/lang-typescript",
      "./x.mjs",
      "x.mjs",
      "Ts",
    ])("leaves %s to the loader", (ref) => {
      expect(detectorIdRefusal(ref, "languages")).toBeNull()
    })
  })

  describe("windowsDriveRefusal", () => {
    const root = "D:\\ws"
    it.each([
      [
        "/opt/plugins/x.mjs",
        'take the drive of the workspace root. Write the drive in: "D:/opt/plugins/x.mjs"',
      ],
      ["\\plugins\\x.mjs", 'Write the drive in: "D:/plugins/x.mjs"'],
      ["\\\\x.mjs", 'Write the drive in: "D:/x.mjs"'],
      ["C:plugins/x.mjs", 'current on that drive. Start it at the root: "C:/plugins/x.mjs"'],
      ["C:plugins\\x.mjs", 'Start it at the root: "C:/plugins/x.mjs"'],
    ])("refuses %s on Windows", (ref, message) => {
      expect(windowsDriveRefusal(ref, "win32", root)).toContain(message)
    })

    it("suggests the UNC share of a workspace on one", () => {
      expect(windowsDriveRefusal("/x.mjs", "win32", "\\\\srv\\share\\ws")).toContain(
        '"//srv/share/x.mjs"',
      )
    })

    it.each([
      "C:/plugins/x.mjs",
      "C:\\plugins\\x.mjs",
      "//server/share/x.mjs",
      "\\\\server\\share\\x.mjs",
      "./plugins/x.mjs",
      ".\\plugins\\x.mjs",
      "@aburi/lang-typescript",
      "file:///C:/plugins/x.mjs",
    ])("accepts %s on Windows", (ref) => {
      expect(windowsDriveRefusal(ref, "win32", root)).toBeNull()
    })

    it.each([
      "C:/plugins/x.mjs",
      "C:\\plugins\\x.mjs",
      "C:plugins/x.mjs",
    ])("refuses %s on POSIX, which has no drives", (ref) => {
      expect(windowsDriveRefusal(ref, "linux", "/ws")).toContain("names the Windows drive C:")
    })

    it.each([
      "/opt/plugins/x.mjs",
      "./plugins/x.mjs",
      "lang-typescript",
      "file:///opt/x.mjs",
    ])("accepts %s on POSIX", (ref) => {
      expect(windowsDriveRefusal(ref, "linux", "/ws")).toBeNull()
    })
  })

  it("uses a file: URL ref verbatim, as rule 2 does for any ref containing a slash", async () => {
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

  const RESULT = "aburi-test-result:"
  it("imports an absolute plugin path containing spaces and URL-special characters", async () => {
    const scratch = await mkdtemp(resolve(tmpdir(), "aburi-plugin-path-"))
    try {
      const pluginPath = resolve(scratch, "local #100%.mjs")
      await writeFile(pluginPath, STUB_PLUGIN, "utf8")
      // Use Node's ESM loader directly: Vitest's module runner does not decode the file URL, and
      // reports `Cannot find module 'file:///…/local%20%23100%25.mjs'` for a file Node loads.
      const loaderUrl = new URL("../src/plugin-loader.ts", import.meta.url).href
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `import { loadPlugins } from ${JSON.stringify(loaderUrl)};
          const loaded = await loadPlugins(${JSON.stringify({
            config: { languages: [pluginPath] },
            workspaceRoot: resolve(scratch, "workspace"),
          })});
          console.log(${JSON.stringify(RESULT)} + JSON.stringify(loaded.languages.map(plugin => plugin.manifest.name)));`,
        ],
        // The package directory, so `tsx` and the loader's own imports resolve from this
        // package whatever directory the test runner was started in.
        { cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 20_000 },
      )
      // Anything tsx or Node prints besides the result is noise, not a loader failure.
      const line = stdout.split("\n").find((l) => l.startsWith(RESULT))
      expect(line, `no result line.\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBeDefined()
      expect(JSON.parse((line as string).slice(RESULT.length))).toEqual(["lang-stub"])
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})

describe("loadPlugins — a manifest the registry refuses", () => {
  const ownsCore: FrameworkPlugin = {
    manifest: {
      ...langManifest,
      name: "framework-core",
      type: "framework",
      provides: { ...langManifest.provides, frameworks: ["core"] },
    },
    init: async () => {},
    classifySymbol: () => null,
  }

  async function refusal(config: Config, modules: Record<string, unknown>): Promise<unknown> {
    return loadPlugins({
      config,
      workspaceRoot: "/tmp",
      importModule: async (specifier) => {
        const module = modules[specifier]
        if (module === undefined)
          throw new Error(`test asked for an unstubbed specifier: ${specifier}`)
        return module
      },
    }).catch((e: unknown) => e)
  }

  async function pluginFault(config: Config, modules: Record<string, unknown>): Promise<CliError> {
    const error = await refusal(config, modules)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).code).toBe("plugin-error")
    expect((error as CliError).cause).toBeInstanceOf(RegistryError)
    return error as CliError
  }

  it("reports a plugin fault, not a crash, keeping the registry's own error as the cause", async () => {
    const error = await pluginFault(
      { frameworks: ["framework-core"] },
      { "@aburi/framework-core": { plugin: ownsCore } },
    )
    expect((error.cause as RegistryError).code).toBe("reserved-namespace")
    expect(error.message).toBe((error.cause as RegistryError).message)
  })

  it("does the same for a conflict between two plugins", async () => {
    const error = await pluginFault(
      { effects: ["effects-a", "effects-b"] },
      {
        "@aburi/effects-a": { plugin: fakeEffectsPlugin },
        "@aburi/effects-b": {
          plugin: {
            ...fakeEffectsPlugin,
            manifest: {
              ...effectsManifest,
              name: "effects-other",
              provides: { ...effectsManifest.provides, derivedByPrefixes: ["effects-plugin:fake"] },
            },
          },
        },
      },
    )
    expect((error.cause as RegistryError).code).toBe("duplicate-prefix")
    expect((error.cause as RegistryError).plugins).toHaveLength(2)
  })

  it("lets a failure the registry did not code through unchanged", async () => {
    const boom = new TypeError("serialization exploded")
    const manifest = {
      ...effectsManifest,
      get version(): string {
        throw boom
      },
    }
    const error = await refusal(
      { effects: ["effects-fake"] },
      { "@aburi/effects-fake": { plugin: { ...fakeEffectsPlugin, manifest } } },
    )
    expect(error).toBe(boom)
  })
})

describe("aburi scan — a plugin whose manifest the registry refuses", () => {
  let scratch = ""

  beforeEach(async () => {
    scratch = await mkdtemp(resolve(tmpdir(), "aburi-registry-refusal-"))
    await populate(scratch, [], { frameworks: ["./framework-core.mjs"] })
    await writeFile(
      resolve(scratch, "framework-core.mjs"),
      `export const plugin = {
  manifest: {
    $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
    name: "framework-core",
    version: "0.0.0",
    type: "framework",
    engines: { aburi: "*" },
    provides: {
      effects: [],
      effectPrefixes: [],
      extKinds: [],
      extKindPrefixes: [],
      derivedByPrefixes: [],
      frameworks: ["core"],
    },
  },
  init: async () => {},
  classifySymbol: () => null,
}
`,
      "utf8",
    )
  })

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  it("exits 3, the code for a manifest violation, with the registry's message", async () => {
    const stdout = new MemStream()
    const stderr = new MemStream()
    const code = await runCli({
      argv: ["scan", "--output-dir", resolve(scratch, "out"), "--format", "json"],
      stdout,
      stderr,
      env: {},
      cwd: scratch,
    })
    expect(code, stderr.text()).toBe(EXIT.GATE)
    expect(stderr.text()).toContain('declares framework name "core" inside a reserved namespace')
    expect(stdout.text()).toBe("")
    expect(existsSync(resolve(scratch, "out"))).toBe(false)
  })
})

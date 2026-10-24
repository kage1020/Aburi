import { resolve } from "node:path"
import { frameworkHintPlugins } from "@aburi/config"
import { RegistryError } from "@aburi/plugin-registry"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import type { Config, FrameworkPlugin, Provides } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { CliError, EXIT, type LoadPluginsOptions, loadPlugins } from "../src"
import { pathExists } from "../src/fs-probe"
import {
  EFFECTS_MANIFEST,
  FAKE_EFFECTS_PLUGIN,
  FAKE_LANGUAGE_PLUGIN,
  FRAMEWORK_MANIFEST,
  pluginModuleSource,
} from "./plugin-fakes"
import { runCliIn } from "./run-cli"
import { writeStubWorkspace } from "./stub-language"
import { writeFileAt } from "./workspace"

const workspace = useScratchWorkspace("plugin-loading")

const FRAMEWORK_CORE: FrameworkPlugin = {
  manifest: {
    ...FRAMEWORK_MANIFEST,
    name: "framework-core",
    provides: { ...FRAMEWORK_MANIFEST.provides, frameworks: ["core"] },
  },
  init: async () => {},
  classifySymbol: () => null,
}

function load(config: Config, module: unknown, extra: Partial<LoadPluginsOptions> = {}) {
  return loadPlugins({
    config,
    workspaceRoot: "/tmp",
    importModule: async () => module,
    ...extra,
  })
}

/** `loadPlugins` with every specifier answered from `modules`, by name. */
function loadModules(config: Config, modules: Record<string, unknown>) {
  return loadPlugins({
    config,
    workspaceRoot: "/tmp",
    importModule: async (specifier) => {
      const module = modules[specifier]
      if (module === undefined)
        throw new Error(`test asked for an unstubbed specifier: ${specifier}`)
      return module
    },
  })
}

describe("loadPlugins — finding the plugin in a module", () => {
  it("takes a named export carrying a manifest, and files it under its field", async () => {
    const loaded = await load(
      { languages: ["lang-fake"] },
      { langFakePlugin: FAKE_LANGUAGE_PLUGIN },
    )

    expect(loaded.languages).toEqual([FAKE_LANGUAGE_PLUGIN])
    expect(loaded.frameworks).toEqual([])
    expect(loaded.effects).toEqual([])
    expect(loaded.registry.listPlugins().map((p) => p.name)).toEqual(["lang-fake"])
  })

  it("prefers the default export", async () => {
    const loaded = await load(
      { effects: ["effects-fake"] },
      {
        default: FAKE_EFFECTS_PLUGIN,
        somethingElse: { manifest: { name: "other", type: "effects" } },
      },
    )

    expect(loaded.effects).toEqual([FAKE_EFFECTS_PLUGIN])
  })

  it.each<[string, Config, () => Promise<unknown>, string]>([
    [
      "a module that fails to import",
      { languages: ["lang-fake"] },
      async () => {
        throw new Error("Cannot find package '@aburi/lang-fake'")
      },
      'Failed to import plugin "lang-fake" (resolved to "@aburi/lang-fake"): Cannot find package',
    ],
    [
      "a specifier that resolves to no module",
      { languages: ["lang-fake"] },
      async () => 42,
      'Plugin "lang-fake" resolved to a number, not a module.',
    ],
    [
      "a module with no export carrying a manifest",
      { languages: ["lang-fake"] },
      async () => ({ hello: 1 }),
      "module has no export carrying a `manifest` field",
    ],
    [
      "a plugin whose manifest type disagrees with its field",
      { effects: ["lang-fake"] },
      async () => ({ plugin: FAKE_LANGUAGE_PLUGIN }),
      'Plugin "lang-fake" is listed under effects but its manifest declares type "lang".',
    ],
  ])("reports %s as the plugin's fault", async (_, config, importModule, says) => {
    const error = await errorFrom(CliError, () =>
      loadPlugins({ config, workspaceRoot: "/tmp", importModule }),
    )

    expect(error.code).toBe("plugin-error")
    expect(error.message).toContain(says)
  })
})

describe("loadPlugins — frameworkHints", () => {
  it("registers each entry under framework:hint and runs it after the configured frameworks", async () => {
    const fakeFramework: FrameworkPlugin = { ...FRAMEWORK_CORE, manifest: FRAMEWORK_MANIFEST }

    const loaded = await load(
      { frameworks: ["framework-fake"] },
      { plugin: fakeFramework },
      {
        syntheticPlugins: frameworkHintPlugins({
          frameworkHints: [
            {
              name: "acme",
              decorators: { AcmeController: { extKind: "framework:acme:controller" } },
            },
          ],
        }),
      },
    )

    expect(loaded.frameworks.map((p) => p.manifest.name)).toEqual(["framework-fake", "hint-acme"])
    expect(loaded.registry.findExtKind("framework:hint:acme:controller")?.owner.name).toBe(
      "hint-acme",
    )
  })

  it("reports an entry the registry refuses as a config error naming the entry", async () => {
    const error = await errorFrom(CliError, () =>
      load(
        {},
        {},
        {
          syntheticPlugins: frameworkHintPlugins({
            frameworkHints: [
              { name: "acme", decorators: { A: { extKind: "framework:acme:a" } } },
              { name: "acme-two", decorators: { B: { extKind: "framework:acme:b" } } },
            ],
          }),
        },
      ),
    )

    expect(error.code).toBe("config-error")
    expect(error.message).toContain(`frameworkHints entry "acme-two"`)
    expect(error.cause).toBeInstanceOf(RegistryError)
  })
})

describe("loadPlugins — a manifest the registry refuses", () => {
  it.each<[string, Config, Record<string, unknown>, string, string]>([
    [
      "a reserved namespace",
      { frameworks: ["framework-core"] },
      { "@aburi/framework-core": { plugin: FRAMEWORK_CORE } },
      "framework-core",
      "reserved-namespace",
    ],
    [
      "a prefix two plugins claim",
      { effects: ["effects-a", "effects-b"] },
      {
        "@aburi/effects-a": { plugin: FAKE_EFFECTS_PLUGIN },
        "@aburi/effects-b": {
          plugin: {
            ...FAKE_EFFECTS_PLUGIN,
            manifest: { ...EFFECTS_MANIFEST, name: "effects-other" },
          },
        },
      },
      "effects-b",
      "duplicate-prefix",
    ],
  ])("reports %s as a fault of the plugin's config entry, keeping the registry's error as the cause", async (_, config, modules, ref, code) => {
    const error = await errorFrom(CliError, () => loadModules(config, modules))

    expect(error.code).toBe("plugin-error")
    expect(error.cause).toBeInstanceOf(RegistryError)
    const cause = error.cause as RegistryError
    expect(cause.code).toBe(code)
    expect(error.message).toBe(`Plugin "${ref}" cannot be registered: ${cause.message}`)
  })

  it("lets a failure the registry did not code through unchanged", async () => {
    const boom = new TypeError("serialization exploded")
    const manifest = {
      ...EFFECTS_MANIFEST,
      get version(): string {
        throw boom
      },
    }

    const error = await errorFrom(TypeError, () =>
      loadModules(
        { effects: ["effects-fake"] },
        { "@aburi/effects-fake": { plugin: { ...FAKE_EFFECTS_PLUGIN, manifest } } },
      ),
    )

    expect(error).toBe(boom)
  })
})

function frameworkModule(name: string, provides: Partial<Provides>): string {
  return pluginModuleSource(
    { ...FRAMEWORK_MANIFEST, name, provides: { ...FRAMEWORK_MANIFEST.provides, ...provides } },
    `  init: async () => {},
  classifySymbol: () => null,`,
  )
}

describe("aburi scan — a configured plugin that cannot be loaded", () => {
  it.each<[string, string[], Record<string, string>, string]>([
    [
      "fails to import",
      ["./framework-missing.mjs"],
      {},
      'Failed to import plugin "./framework-missing.mjs"',
    ],
    [
      "declares a prefix another configured plugin declared",
      ["./framework-one.mjs", "./framework-two.mjs"],
      {
        "framework-one.mjs": frameworkModule("framework-one", {
          extKindPrefixes: ["framework:acme"],
        }),
        "framework-two.mjs": frameworkModule("framework-two", {
          extKindPrefixes: ["framework:acme"],
        }),
      },
      'Plugin "./framework-two.mjs" cannot be registered: extKind prefix "framework:acme" is already declared by plugin "framework-one".',
    ],
    [
      "has the name of another configured plugin and a different manifest",
      ["./framework-one.mjs", "./framework-copy.mjs"],
      {
        "framework-one.mjs": frameworkModule("framework-one", {
          extKindPrefixes: ["framework:acme"],
        }),
        "framework-copy.mjs": frameworkModule("framework-one", {
          extKindPrefixes: ["framework:copy"],
        }),
      },
      'Plugin "./framework-copy.mjs" cannot be registered: Plugin "framework-one" is already registered with a different manifest.',
    ],
    [
      "declares a name in a reserved namespace",
      ["./framework-core.mjs"],
      { "framework-core.mjs": frameworkModule("framework-core", { frameworks: ["core"] }) },
      'Plugin "./framework-core.mjs" cannot be registered: Plugin "framework-core" declares framework name "core" inside a reserved namespace',
    ],
    [
      "declares a prefix outside the namespaces its type may own",
      ["./framework-shape.mjs"],
      {
        "framework-shape.mjs": frameworkModule("framework-shape", {
          extKindPrefixes: ["effects:acme"],
        }),
      },
      'Plugin "./framework-shape.mjs" cannot be registered: Plugin "framework-shape" (type framework) declares extKind prefix "effects:acme" outside its allowed roots',
    ],
    [
      "holds a manifest value JSON cannot carry",
      ["./framework-odd.mjs"],
      {
        "framework-odd.mjs": `${frameworkModule("framework-odd", {})}plugin.manifest.homepage = undefined\n`,
      },
      'Plugin "./framework-odd.mjs" cannot be registered: Plugin manifest contains a non-JSON value (undefined) at $.homepage',
    ],
  ])("exits 3 for a plugin that %s, naming its config entry, before writing anything", async (_, frameworks, files, says) => {
    await writeStubWorkspace(workspace.root, [], { frameworks })
    for (const [path, content] of Object.entries(files)) {
      await writeFileAt(workspace.root, path, content)
    }

    const { code, stdout, stderr } = await runCliIn(workspace.root, ["scan", "--format", "json"])

    expect(code, stderr).toBe(EXIT.GATE)
    expect(stderr).toContain(says)
    expect(stdout).toBe("")
    expect(await pathExists(resolve(workspace.root, "out"))).toBe(false)
  })
})

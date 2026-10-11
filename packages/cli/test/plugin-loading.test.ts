import { resolve } from "node:path"
import { frameworkHintPlugins } from "@aburi/config"
import { RegistryError } from "@aburi/plugin-registry"
import { errorFrom, useScratchWorkspace } from "@aburi/test-support"
import type { Config, FrameworkPlugin } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { CliError, EXIT, type LoadPluginsOptions, loadPlugins } from "../src"
import { pathExists } from "../src/fs-probe"
import {
  EFFECTS_MANIFEST,
  FAKE_EFFECTS_PLUGIN,
  FAKE_LANGUAGE_PLUGIN,
  LANG_MANIFEST,
} from "./plugin-fakes"
import { runCliIn } from "./run-cli"
import { writeStubWorkspace } from "./stub-language"
import { writeFileAt } from "./workspace"

const workspace = useScratchWorkspace("plugin-loading")

const FRAMEWORK_CORE: FrameworkPlugin = {
  manifest: {
    ...LANG_MANIFEST,
    name: "framework-core",
    type: "framework",
    provides: { ...LANG_MANIFEST.provides, frameworks: ["core"] },
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
    const fakeFramework: FrameworkPlugin = {
      ...FRAMEWORK_CORE,
      manifest: { ...LANG_MANIFEST, name: "framework-fake", type: "framework" },
    }

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
  it.each<[string, Config, Record<string, unknown>, string]>([
    [
      "a reserved namespace",
      { frameworks: ["framework-core"] },
      { "@aburi/framework-core": { plugin: FRAMEWORK_CORE } },
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
      "duplicate-prefix",
    ],
  ])("reports %s as a plugin fault, keeping the registry's error as the cause", async (_, config, modules, code) => {
    const error = await errorFrom(CliError, () => loadModules(config, modules))

    expect(error.code).toBe("plugin-error")
    expect(error.cause).toBeInstanceOf(RegistryError)
    expect((error.cause as RegistryError).code).toBe(code)
    expect(error.message).toBe((error.cause as RegistryError).message)
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

describe("aburi scan — a plugin whose manifest the registry refuses", () => {
  it("exits 3 with the registry's message, before writing anything", async () => {
    await writeStubWorkspace(workspace.root, [], { frameworks: ["./framework-core.mjs"] })
    await writeFileAt(
      workspace.root,
      "framework-core.mjs",
      `export const plugin = ${JSON.stringify({ manifest: FRAMEWORK_CORE.manifest })}
plugin.init = async () => {}
plugin.classifySymbol = () => null
`,
    )

    const { code, stdout, stderr } = await runCliIn(workspace.root, ["scan", "--format", "json"])

    expect(code, stderr).toBe(EXIT.GATE)
    expect(stderr).toContain('declares framework name "core" inside a reserved namespace')
    expect(stdout).toBe("")
    expect(await pathExists(resolve(workspace.root, "out"))).toBe(false)
  })
})

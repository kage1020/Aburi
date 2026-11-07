import { CORE_EFFECTS } from "@aburi/core"
import { useScratchWorkspace } from "@aburi/test-support"
import type { PluginManifest } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { EXIT } from "../src"
import {
  EFFECTS_MANIFEST,
  FRAMEWORK_MANIFEST,
  LANG_MANIFEST,
  pluginModuleSource,
} from "./plugin-fakes"
import { runCliIn } from "./run-cli"
import { writeConfig, writeFileAt } from "./workspace"

const workspace = useScratchWorkspace("vocab")

const EFFECTS: PluginManifest = {
  ...EFFECTS_MANIFEST,
  name: "effects-acme",
  version: "1.2.3",
  provides: {
    ...EFFECTS_MANIFEST.provides,
    effects: [{ id: "x-acme:charge", description: "Card charge" }],
    effectPrefixes: ["x-acme"],
    derivedByPrefixes: ["effects-plugin:acme"],
  },
}

const FRAMEWORK: PluginManifest = {
  ...FRAMEWORK_MANIFEST,
  name: "framework-acme",
  version: "2.0.0",
  provides: {
    ...FRAMEWORK_MANIFEST.provides,
    extKinds: [{ id: "framework:acme:job", baseKind: "class", description: "Acme job" }],
    extKindPrefixes: ["framework:acme"],
    derivedByPrefixes: ["framework:acme"],
    frameworks: ["acme"],
  },
}

const LANG: PluginManifest = { ...LANG_MANIFEST, name: "lang-acme", version: "0.1.0" }

const BETA_HINT = { name: "beta", decorators: { BetaJob: { extKind: "framework:beta:job" } } }

async function writePlugin(rel: string, manifest: PluginManifest): Promise<void> {
  // A manifest is all `aburi vocab` reads, so an `init` that ran would end the run.
  await writeFileAt(
    workspace.root,
    rel,
    pluginModuleSource(manifest, `  init: async () => { throw new Error("init ran") },`),
  )
}

/** Keys out of load order, so that the order the output keeps is the loader's. */
async function writeAcmeWorkspace(extra: Record<string, unknown> = {}): Promise<void> {
  await writePlugin("plugins/effects.mjs", EFFECTS)
  await writePlugin("plugins/framework.mjs", FRAMEWORK)
  await writePlugin("plugins/lang.mjs", LANG)
  await writeConfig(workspace.root, {
    frameworkHints: [BETA_HINT],
    effects: ["./plugins/effects.mjs"],
    frameworks: ["./plugins/framework.mjs"],
    languages: ["./plugins/lang.mjs"],
    ...extra,
  })
}

function vocab(...argv: string[]) {
  return runCliIn(workspace.root, ["vocab", ...argv])
}

const coreRows = CORE_EFFECTS.map(({ id, description }) => ({ id, description, owner: null }))

const PLUGINS = [
  {
    name: "lang-acme",
    version: "0.1.0",
    type: "lang",
    listedIn: { field: "languages", ref: "./plugins/lang.mjs" },
  },
  {
    name: "framework-acme",
    version: "2.0.0",
    type: "framework",
    listedIn: { field: "frameworks", ref: "./plugins/framework.mjs" },
  },
  {
    name: "effects-acme",
    version: "1.2.3",
    type: "effects",
    listedIn: { field: "effects", ref: "./plugins/effects.mjs" },
  },
  {
    name: "hint-beta",
    version: "0.0.0",
    type: "framework",
    listedIn: { field: "frameworkHints", ref: "beta" },
  },
]

const [, FRAMEWORK_PLUGIN, EFFECTS_PLUGIN] = PLUGINS

describe("aburi vocab list --json", () => {
  it("writes every list, the core effect ids first and ownerless, the plugins in load order", async () => {
    await writeAcmeWorkspace()

    const run = await vocab("list", "--json")

    expect(run).toMatchObject({ code: EXIT.SUCCESS, stderr: "" })
    expect(JSON.parse(run.stdout)).toEqual({
      plugins: PLUGINS,
      effects: [
        ...coreRows,
        { id: "x-acme:charge", description: "Card charge", owner: "effects-acme" },
      ],
      effectPrefixes: [{ prefix: "x-acme", owner: "effects-acme" }],
      extKinds: [
        {
          id: "framework:acme:job",
          baseKind: "class",
          description: "Acme job",
          owner: "framework-acme",
        },
      ],
      extKindPrefixes: [
        { prefix: "framework:acme", owner: "framework-acme" },
        { prefix: "framework:hint:beta", owner: "hint-beta" },
      ],
      frameworks: [
        { name: "acme", owner: "framework-acme" },
        { name: "beta", owner: "hint-beta" },
      ],
      derivedByPrefixes: [
        { prefix: "framework:acme", owner: "framework-acme" },
        { prefix: "effects-plugin:acme", owner: "effects-acme" },
      ],
    })
    expect(run.stdout.endsWith("}\n")).toBe(true)
  })

  it.each([
    ["effects", ["effects", "effectPrefixes"]],
    ["extkinds", ["extKinds", "extKindPrefixes"]],
    ["plugins", ["plugins"]],
  ])(
    "writes for %s only the lists its table shows, wherever --json is written",
    async (view, keys) => {
      await writeAcmeWorkspace()

      const after = await vocab(view, "--json")
      const before = await vocab("--json", view)

      expect(Object.keys(JSON.parse(after.stdout))).toEqual(keys)
      expect(before).toEqual(after)
    },
  )
})

describe("aburi vocab — the tables", () => {
  it.each([
    [
      "plugins",
      [
        `lang-acme       0.1.0  lang       languages "./plugins/lang.mjs"`,
        `framework-acme  2.0.0  framework  frameworks "./plugins/framework.mjs"`,
        `effects-acme    1.2.3  effects    effects "./plugins/effects.mjs"`,
        `hint-beta       0.0.0  framework  frameworkHints "beta"`,
      ],
    ],
    [
      "extkinds",
      [
        "framework-acme  framework:acme:job  class  Acme job",
        "framework-acme  (prefix framework:acme)",
        "hint-beta       (prefix framework:hint:beta)",
      ],
    ],
  ])("aligns %s in columns, a plugin's values before its prefixes", async (view, rows) => {
    await writeAcmeWorkspace()

    expect(await vocab(view)).toEqual({
      code: EXIT.SUCCESS,
      stdout: rows.map((row) => `${row}\n`).join(""),
      stderr: "",
    })
  })

  it("lists the core effect ids as owned by core, ahead of the plugins' ids and prefixes", async () => {
    await writeAcmeWorkspace()

    const lines = (await vocab("effects")).stdout.split("\n")

    expect(lines.slice(0, 2)).toEqual([
      "core          db.read            Database read",
      "core          db.write           Database write",
    ])
    expect(lines.slice(-3)).toEqual([
      "effects-acme  x-acme:charge      Card charge",
      "effects-acme  (prefix x-acme)",
      "",
    ])
    expect(lines).toHaveLength(CORE_EFFECTS.length + 3)
  })

  it("writes list as titled sections, an empty one as (none), no line ending in a space", async () => {
    await writePlugin("plugins/lang.mjs", LANG)
    await writeConfig(workspace.root, { languages: ["./plugins/lang.mjs"] })

    const { code, stdout } = await vocab("list")
    const sections = stdout.split("\n\n")

    expect(code).toBe(EXIT.SUCCESS)
    expect(sections.map((section) => section.split("\n")[0])).toEqual([
      "Plugins",
      "Effects",
      "extKinds",
      "Frameworks",
      "derivedBy prefixes",
    ])
    expect(sections[0]).toBe(`Plugins\n  lang-acme  0.1.0  lang  languages "./plugins/lang.mjs"`)
    expect(sections.slice(2)).toEqual([
      "extKinds\n  (none)",
      "Frameworks\n  (none)",
      "derivedBy prefixes\n  (none)\n",
    ])
    expect(stdout.split("\n").filter((line) => line.endsWith(" "))).toEqual([])
  })
})

describe("aburi vocab who-owns", () => {
  const block = (...lines: string[]) => lines.join("\n")

  it.each([
    [
      "x-acme:charge",
      block(
        "Vocabulary:  effect",
        "Plugin:      effects-acme (v1.2.3)",
        "Type:        effects",
        'Listed in:   effects "./plugins/effects.mjs"',
        "Declaration: explicit (provides.effects[])",
        "Description: Card charge",
      ),
    ],
    [
      "x-acme:refund",
      block(
        "Vocabulary:  effect",
        "Plugin:      effects-acme (v1.2.3)",
        "Type:        effects",
        'Listed in:   effects "./plugins/effects.mjs"',
        "Declaration: prefix x-acme (provides.effectPrefixes[])",
      ),
    ],
    [
      "db.read",
      block(
        "Vocabulary:  effect",
        "Declaration: core vocabulary, owned by no plugin",
        "Description: Database read",
      ),
    ],
    [
      "framework:acme:job",
      block(
        "Vocabulary:  extKind",
        "Plugin:      framework-acme (v2.0.0)",
        "Type:        framework",
        'Listed in:   frameworks "./plugins/framework.mjs"',
        "Declaration: explicit (provides.extKinds[])",
        "Base kind:   class",
        "Description: Acme job",
        "",
        "Vocabulary:  derivedBy",
        "Plugin:      framework-acme (v2.0.0)",
        "Type:        framework",
        'Listed in:   frameworks "./plugins/framework.mjs"',
        "Declaration: prefix framework:acme (provides.derivedByPrefixes[])",
      ),
    ],
    [
      "beta",
      block(
        "Vocabulary:  framework",
        "Plugin:      hint-beta (v0.0.0)",
        "Type:        framework",
        'Listed in:   frameworkHints "beta"',
        "Declaration: explicit (provides.frameworks[])",
      ),
    ],
  ])("answers %s with a block for each vocabulary it is in", async (value, expected) => {
    await writeAcmeWorkspace()

    expect(await vocab("who-owns", value)).toEqual({
      code: EXIT.SUCCESS,
      stdout: `${expected}\n`,
      stderr: "",
    })
  })

  it("names the plugin under --json, and the prefix a covered value falls under", async () => {
    await writeAcmeWorkspace()

    const run = await vocab("who-owns", "x-acme:refund", "--json")

    expect(run.code).toBe(EXIT.SUCCESS)
    expect(JSON.parse(run.stdout)).toEqual({
      value: "x-acme:refund",
      owners: [
        {
          vocabulary: "effect",
          declaration: "prefix",
          prefix: "x-acme",
          description: null,
          plugin: EFFECTS_PLUGIN,
        },
      ],
    })
  })

  it("gives an extKind a baseKind under --json, null when a prefix covers it", async () => {
    await writeAcmeWorkspace()

    const run = await vocab("who-owns", "framework:acme:saga", "--json")

    expect(JSON.parse(run.stdout).owners).toEqual([
      {
        vocabulary: "extKind",
        declaration: "prefix",
        prefix: "framework:acme",
        description: null,
        baseKind: null,
        plugin: FRAMEWORK_PLUGIN,
      },
      {
        vocabulary: "derivedBy",
        declaration: "prefix",
        prefix: "framework:acme",
        description: null,
        plugin: FRAMEWORK_PLUGIN,
      },
    ])
  })

  it("exits 1 for a value in no vocabulary, saying so on stderr, or with no owners under --json", async () => {
    await writeAcmeWorkspace()

    expect(await vocab("who-owns", "x-nobody:thing")).toEqual({
      code: EXIT.RUNTIME,
      stdout: "",
      stderr:
        'No owner for "x-nobody:thing": it is no core effect id, and no loaded plugin declares it or a prefix over it.\n',
    })
    const json = await vocab("who-owns", "x-nobody:thing", "--json")
    expect(json.code).toBe(EXIT.RUNTIME)
    expect(JSON.parse(json.stdout)).toEqual({ value: "x-nobody:thing", owners: [] })
  })
})

describe("aburi vocab — what it loads", () => {
  it("lists the core effect ids alone with no config found, and says so on stderr", async () => {
    const run = await vocab("effects", "--json")

    expect(run.code).toBe(EXIT.SUCCESS)
    expect(JSON.parse(run.stdout)).toEqual({ effects: coreRows, effectPrefixes: [] })
    expect(run.stderr).toBe(
      "⚠ No aburi.json was found, so no plugin is loaded: only the core effect vocabulary is known.\n",
    )
  })

  it("answers for an effect plugin alone: it needs no language plugin and calls no init", async () => {
    await writePlugin("plugins/effects.mjs", EFFECTS)
    await writeConfig(workspace.root, { effects: ["./plugins/effects.mjs"] })

    expect(await vocab("plugins")).toEqual({
      code: EXIT.SUCCESS,
      stdout: `effects-acme  1.2.3  effects  effects "./plugins/effects.mjs"\n`,
      stderr: "",
    })
  })

  it("lists a plugin listed twice once, under the entry that loaded it first", async () => {
    await writeAcmeWorkspace({
      effects: ["./plugins/effects.mjs", "./plugins/../plugins/effects.mjs"],
    })

    const run = await vocab("plugins", "--json")

    expect(JSON.parse(run.stdout).plugins).toEqual(PLUGINS)
  })

  it("exits 3 naming the config entry for a plugin that fails to import", async () => {
    await writeAcmeWorkspace({ effects: ["./plugins/missing.mjs"] })

    const run = await vocab("list")

    expect(run.code).toBe(EXIT.GATE)
    expect(run.stdout).toBe("")
    expect(run.stderr).toContain('Failed to import plugin "./plugins/missing.mjs"')
  })

  it("exits 2 naming the hint for a frameworkHints entry the registry refuses", async () => {
    await writeAcmeWorkspace({ frameworkHints: [{ ...BETA_HINT, name: "acme" }] })

    const run = await vocab("list")

    expect(run.code).toBe(EXIT.INPUT_ERROR)
    expect(run.stderr).toContain('frameworkHints entry "acme" cannot be registered')
  })

  it.each([
    [[]],
    [["nope"]],
    [["who-owns"]],
    [["who-owns", "a", "b"]],
    [["list", "--config", "aburi.json", "--config", "aburi.json"]],
  ])("exits 2 for vocab %j", async (argv) => {
    await writeAcmeWorkspace()

    const run = await vocab(...argv)

    expect(run.code).toBe(EXIT.INPUT_ERROR)
    expect(run.stdout).toBe("")
  })
})

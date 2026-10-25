import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import type { IR } from "@aburi/types"
import { beforeEach, describe, expect, it } from "vitest"
import { EXIT, IR_JSON_FILENAME } from "../src"
import { FRAMEWORK_MANIFEST, pluginModuleSource } from "./plugin-fakes"
import { runCliIn } from "./run-cli"
import { TYPESCRIPT, writeConfig } from "./workspace"

const workspace = useScratchWorkspace("plugin-ref-vocabulary")

beforeEach(async () => {
  await workspace.writeSource("src/app.ts", "export const x = 1\n")
})

async function scanWith(config: Record<string, unknown>) {
  await writeConfig(workspace.root, config)
  const { code, stdout, stderr } = await runCliIn(workspace.root, ["scan", "--no-timestamp"])
  return { code, stderr, output: `${stderr}${stdout}` }
}

async function componentFrameworks(): Promise<unknown> {
  const ir = JSON.parse(
    await readFile(resolve(workspace.root, "out", IR_JSON_FILENAME), "utf8"),
  ) as IR
  return ir.components[0]?.frameworks
}

const appWith = (frameworks: string[]) => ({
  components: [{ id: "app", roots: ["src"], languages: ["ts"], frameworks }],
})

describe("aburi scan — a detector id where a plugin ref belongs", () => {
  it.each([
    [
      "a language id",
      { languages: ["ts"] },
      'Plugin "ts" in "languages" is not a plugin name',
      'Write "lang-typescript".',
    ],
    [
      "a framework id",
      { ...TYPESCRIPT, frameworks: ["nestjs"] },
      'Plugin "nestjs" in "frameworks" is not a plugin name',
      'Write "framework-nestjs".',
    ],
  ])("refuses %s at exit 2, naming the plugin to write", async (_, config, refusal, fix) => {
    const { code, output } = await scanWith(config)

    expect(code, output).toBe(EXIT.INPUT_ERROR)
    expect(output).toContain(refusal)
    expect(output).toContain(fix)
  })
})

describe("aburi scan — a plugin name where a framework id belongs", () => {
  it.each([
    [
      "a loaded plugin",
      { ...TYPESCRIPT, frameworks: ["framework-nestjs"], ...appWith(["framework-nestjs"]) },
      "framework-nestjs",
      'Write "nestjs".',
    ],
    [
      "a first-party plugin that is not loaded",
      { ...TYPESCRIPT, ...appWith(["framework-next"]) },
      "framework-next",
      'Write "nextjs".',
    ],
  ])("warns about %s, naming the framework id, and keeps the value", async (_, config, value, fix) => {
    const { code, output } = await scanWith(config)

    expect(code, output).toBe(EXIT.SUCCESS)
    expect(output).toContain(
      `Component "app" lists "${value}" in frameworks, which names a plugin, not a framework`,
    )
    expect(output).toContain(fix)
    expect(await componentFrameworks()).toEqual([value])
  })

  it("says nothing about framework ids, hyphenated or provided by no plugin", async () => {
    const { code, output } = await scanWith({
      ...TYPESCRIPT,
      frameworks: ["framework-nestjs"],
      frameworkHints: [{ name: "acme-rpc", decorators: {} }],
      ...appWith(["nestjs", "acme-rpc", "vue"]),
    })

    expect(code, output).toBe(EXIT.SUCCESS)
    expect(output).not.toContain("names a plugin")
  })

  it("says nothing when the plugin's name is also the framework it provides", async () => {
    await workspace.writeSource(
      "plugins/acme.mjs",
      pluginModuleSource(
        {
          ...FRAMEWORK_MANIFEST,
          name: "acme-rpc",
          provides: { ...FRAMEWORK_MANIFEST.provides, frameworks: ["acme-rpc"] },
        },
        `  async init() {},
  classifySymbol() {
    return null
  },`,
      ),
    )

    const { code, output } = await scanWith({
      ...TYPESCRIPT,
      frameworks: ["./plugins/acme.mjs"],
      ...appWith(["acme-rpc"]),
    })

    expect(code, output).toBe(EXIT.SUCCESS)
    expect(output).not.toContain("names a plugin")
  })
})

describe("aburi scan — pluginOptions keys and the plugins it loaded", () => {
  const PRISMA = { ...TYPESCRIPT, effects: ["effects-prisma"] }
  const unmatched = (key: string, loaded: string) =>
    `⚠ pluginOptions["${key}"] names no loaded plugin (loaded: ${loaded}).`
  const hint = (key: string, entry: string) =>
    `⚠ pluginOptions["${key}"] names the plugin built from the frameworkHints entry "${entry}", which takes no options; write its rules in that entry.`

  it.each([
    [
      "warns about a misspelled plugin name",
      { ...PRISMA, pluginOptions: { "effects-prsima": {} } },
      [unmatched("effects-prsima", "lang-typescript, effects-prisma")],
    ],
    [
      "warns about a plugin no list enables",
      { ...TYPESCRIPT, pluginOptions: { "effects-prisma": {} } },
      [unmatched("effects-prisma", "lang-typescript")],
    ],
    [
      "warns about each of several keys, in config order, and not the one that matches",
      {
        ...PRISMA,
        pluginOptions: { "framework-nestjs": {}, "effects-prisma": {}, "effects-pino": {} },
      },
      [
        unmatched("framework-nestjs", "lang-typescript, effects-prisma"),
        unmatched("effects-pino", "lang-typescript, effects-prisma"),
      ],
    ],
    [
      "says nothing about a loaded plugin's name",
      { ...PRISMA, pluginOptions: { "effects-prisma": {} } },
      [],
    ],
    [
      "lists the plugins in load order, a frameworkHints entry's last, and sends options for that entry's plugin to the entry, in config order",
      {
        ...PRISMA,
        frameworks: ["framework-nestjs"],
        frameworkHints: [{ name: "acme", decorators: {} }],
        pluginOptions: { "hint-acme": {}, "effects-prsima": {} },
      },
      [
        hint("hint-acme", "acme"),
        unmatched("effects-prsima", "lang-typescript, framework-nestjs, effects-prisma, hint-acme"),
      ],
    ],
    [
      "names no frameworkHints entry for a key that only looks like one",
      { ...PRISMA, pluginOptions: { "hint-acme": {} } },
      [unmatched("hint-acme", "lang-typescript, effects-prisma")],
    ],
  ])("%s, on stderr alone, and exits 0", async (_, config, expected) => {
    const { code, stderr, output } = await scanWith(config)

    expect(code, output).toBe(EXIT.SUCCESS)
    expect(stderr).toBe(expected.map((line) => `${line}\n`).join(""))
  })
})

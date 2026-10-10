import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { useScratchWorkspace } from "@aburi/test-support"
import type { IR } from "@aburi/types"
import { beforeEach, describe, expect, it } from "vitest"
import { EXIT, IR_JSON_FILENAME } from "../src"
import { runCliIn } from "./run-cli"
import { TYPESCRIPT, writeConfig } from "./workspace"

const workspace = useScratchWorkspace("plugin-ref-vocabulary")

beforeEach(async () => {
  await workspace.writeSource("src/app.ts", "export const x = 1\n")
})

async function scanWith(config: Record<string, unknown>) {
  await writeConfig(workspace.root, config)
  const { code, stdout, stderr } = await runCliIn(workspace.root, ["scan", "--no-timestamp"])
  return { code, output: `${stderr}${stdout}` }
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
      `export const plugin = {
  manifest: {
    $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
    name: "acme-rpc",
    version: "0.0.0",
    type: "framework",
    engines: { aburi: "*" },
    provides: {
      effects: [],
      effectPrefixes: [],
      extKinds: [],
      extKindPrefixes: [],
      derivedByPrefixes: [],
      frameworks: ["acme-rpc"],
    },
  },
  async init() {},
  classifySymbol() {
    return null
  },
}
`,
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

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { IR_JSON_FILENAME } from "../src"
import { runCli } from "../src/run"
import { MemStream } from "./fixtures"

/**
 * The two places a config can hold the wrong vocabulary and still pass the schema: a detector
 * id where a plugin ref belongs, and a plugin name where a framework id belongs.
 */

let workRoot = ""

beforeEach(async () => {
  workRoot = await mkdtemp(resolve(tmpdir(), "aburi-ref-vocab-"))
  await write("src/app.ts", "export const x = 1\n")
})

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true })
})

async function write(relativePath: string, body: string): Promise<void> {
  const path = resolve(workRoot, relativePath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, "utf8")
}

async function writeConfig(config: Record<string, unknown>): Promise<void> {
  await write(
    "aburi.json",
    JSON.stringify({
      $schema: "https://aburi.kage1020.com/schema/aburi.config.v1.json",
      ...config,
    }),
  )
}

async function scan(): Promise<{ exitCode: number; stderr: string }> {
  const stdout = new MemStream()
  const stderr = new MemStream()
  const exitCode = await runCli({
    argv: ["scan", "--no-timestamp"],
    cwd: workRoot,
    stdout,
    stderr,
    env: {},
  })
  return { exitCode, stderr: `${stderr.text()}${stdout.text()}` }
}

async function componentFrameworks(): Promise<unknown> {
  const ir = JSON.parse(await readFile(resolve(workRoot, "out", IR_JSON_FILENAME), "utf8"))
  return ir.components[0].frameworks
}

const appComponent = (frameworks: string[]) => ({
  components: [{ id: "app", roots: ["src"], languages: ["ts"], frameworks }],
})

describe("a detector id where a plugin ref belongs", () => {
  it("refuses a language id with exit 2 and names the plugin to write", async () => {
    await writeConfig({ languages: ["ts"] })

    const { exitCode, stderr } = await scan()

    expect(exitCode, stderr).toBe(2)
    expect(stderr).toContain(`Plugin "ts" in "languages" is not a plugin name`)
    expect(stderr).toContain(`Write "lang-typescript".`)
  })

  it("refuses a framework id the same way", async () => {
    await writeConfig({ languages: ["lang-typescript"], frameworks: ["nestjs"] })

    const { exitCode, stderr } = await scan()

    expect(exitCode, stderr).toBe(2)
    expect(stderr).toContain(`Write "framework-nestjs".`)
  })
})

describe("a plugin name where a framework id belongs", () => {
  it("warns, naming the id the loaded plugin provides, and keeps the value", async () => {
    await writeConfig({
      languages: ["lang-typescript"],
      frameworks: ["framework-nestjs"],
      ...appComponent(["framework-nestjs"]),
    })

    const { exitCode, stderr } = await scan()

    expect(exitCode, stderr).toBe(0)
    expect(stderr).toContain(
      `Component "app" lists "framework-nestjs" in frameworks, which names a plugin, not a framework`,
    )
    expect(stderr).toContain(`Write "nestjs".`)
    expect(await componentFrameworks()).toEqual(["framework-nestjs"])
  })

  it("knows a first-party plugin's framework id when the plugin is not loaded", async () => {
    await writeConfig({ languages: ["lang-typescript"], ...appComponent(["framework-next"]) })

    const { exitCode, stderr } = await scan()

    expect(exitCode, stderr).toBe(0)
    expect(stderr).toContain(`Component "app" lists "framework-next"`)
    expect(stderr).toContain(`Write "nextjs".`)
    expect(await componentFrameworks()).toEqual(["framework-next"])
  })

  it("says nothing about framework ids, hyphenated or not provided by any plugin", async () => {
    await writeConfig({
      languages: ["lang-typescript"],
      frameworks: ["framework-nestjs"],
      frameworkHints: [{ name: "acme-rpc", decorators: {} }],
      ...appComponent(["nestjs", "acme-rpc", "vue"]),
    })

    const { exitCode, stderr } = await scan()

    expect(exitCode, stderr).toBe(0)
    expect(stderr).not.toContain("names a plugin")
  })

  it("says nothing when the plugin's name is also the framework it provides", async () => {
    await write(
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
    await writeConfig({
      languages: ["lang-typescript"],
      frameworks: ["./plugins/acme.mjs"],
      ...appComponent(["acme-rpc"]),
    })

    const { exitCode, stderr } = await scan()

    expect(stderr).not.toContain("names a plugin")
    expect(exitCode, stderr).toBe(0)
  })
})

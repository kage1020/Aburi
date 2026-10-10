import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import type { IR, Symbol as IRSymbol } from "@aburi/types"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { IR_JSON_FILENAME } from "../src"
import { runCli } from "../src/run"
import { MemStream } from "./fixtures"

let workRoot = ""

beforeEach(async () => {
  workRoot = await mkdtemp(resolve(tmpdir(), "aburi-hints-"))
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
      languages: ["lang-typescript"],
      ...config,
    }),
  )
}

async function scan(): Promise<{ exitCode: number; output: string }> {
  const stdout = new MemStream()
  const stderr = new MemStream()
  const exitCode = await runCli({
    argv: ["scan", "--no-timestamp"],
    cwd: workRoot,
    stdout,
    stderr,
    env: {},
  })
  return { exitCode, output: `${stderr.text()}${stdout.text()}` }
}

async function symbolNamed(name: string): Promise<IRSymbol> {
  const ir = JSON.parse(await readFile(resolve(workRoot, "out", IR_JSON_FILENAME), "utf8")) as IR
  const symbol = ir.symbols.find((s) => s.name === name)
  if (symbol === undefined) throw new Error(`no Symbol named ${name} in the IR`)
  return symbol
}

const SOURCE = `function AcmeController(): ClassDecorator { return () => {} }
function AcmeInternal(): ClassDecorator { return () => {} }

@AcmeController()
export class UserController {
  get(id: string) { return id }
}

@AcmeInternal()
export class Secret {
  peek() { return 1 }
}

export class OrderHandler {
  handle() { return 2 }
}
`

describe("frameworkHints in aburi scan", () => {
  it("scans the guide's example, applying both the decorator and the class-name rule", async () => {
    await writeConfig({
      frameworkHints: [
        {
          name: "acme",
          decorators: {
            AcmeController: { boundary: true, extKind: "framework:acme:controller" },
          },
          classNamePatterns: { "*Handler": { extKind: "framework:acme:handler" } },
        },
      ],
    })
    await write("src/a.ts", SOURCE)

    const { exitCode, output } = await scan()

    expect(exitCode, output).toBe(0)
    const controller = await symbolNamed("UserController")
    expect(controller.extKind).toBe("framework:hint:acme:controller")
    expect(controller.decorators.map((d) => [d.name, d.boundary])).toEqual([
      ["AcmeController", true],
    ])
    expect((await symbolNamed("OrderHandler")).extKind).toBe("framework:hint:acme:handler")
    expect((await symbolNamed("Secret")).extKind).toBeNull()
  })

  it("applies boundary, derivedBy and drop from a hint that sets no extKind", async () => {
    await writeConfig({
      frameworkHints: [
        {
          name: "acme",
          decorators: {
            AcmeController: { boundary: true, derivedBy: "framework-hint:acme:controller" },
            AcmeInternal: { drop: true },
          },
          classNamePatterns: { "*Handler": { drop: true } },
        },
      ],
    })
    await write("src/a.ts", SOURCE)

    const { exitCode, output } = await scan()

    expect(exitCode, output).toBe(0)
    const controller = await symbolNamed("UserController")
    expect(controller.dropped).toBe(false)
    expect(controller.decorators[0]?.boundary).toBe(true)
    expect(controller.derivedBy).toContain("framework-hint:acme:controller")
    const secret = await symbolNamed("Secret")
    expect([secret.dropped, secret.dropReason]).toEqual([
      true,
      'frameworkHints "acme": @AcmeInternal',
    ])
    const handler = await symbolNamed("OrderHandler")
    expect([handler.dropped, handler.dropReason]).toEqual([
      true,
      'frameworkHints "acme": class *Handler',
    ])
  })

  it("leaves a Symbol a configured framework plugin classified to that plugin", async () => {
    await writeConfig({
      frameworks: ["framework-nestjs"],
      frameworkHints: [
        { name: "acme", classNamePatterns: { "*Handler": { extKind: "framework:acme:handler" } } },
      ],
    })
    await write(
      "src/a.ts",
      `import { Controller, Get } from "@nestjs/common"

@Controller("users")
export class UsersHandler {
  @Get() list() { return [] }
}

export class OrderHandler {
  handle() { return 2 }
}
`,
    )

    const { exitCode, output } = await scan()

    expect(exitCode, output).toBe(0)
    const nest = await symbolNamed("UsersHandler")
    expect(nest.extKind).toBe("framework:nestjs:controller")
    expect(nest.decorators[0]?.boundary).toBe(true)
    expect((await symbolNamed("OrderHandler")).extKind).toBe("framework:hint:acme:handler")
  })

  it("refuses two entries that derive the same namespace as a config error naming the entry", async () => {
    await writeConfig({
      frameworkHints: [
        { name: "acme", decorators: { A: { extKind: "framework:acme:a" } } },
        { name: "acme-two", decorators: { B: { extKind: "framework:acme:b" } } },
      ],
    })
    await write("src/a.ts", "export const x = 1\n")

    const { exitCode, output } = await scan()

    expect(exitCode, output).toBe(2)
    expect(output).toContain(`frameworkHints entry "acme-two" cannot be registered`)
  })
})

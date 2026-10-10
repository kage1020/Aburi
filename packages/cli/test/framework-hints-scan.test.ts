import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import type { IR, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { EXIT, IR_JSON_FILENAME } from "../src"
import { runCliIn } from "./run-cli"
import { TYPESCRIPT, writeConfig as writeConfigAt } from "./workspace"

const workspace = useScratchWorkspace("framework-hints")

async function writeConfig(config: Record<string, unknown>): Promise<void> {
  await writeConfigAt(workspace.root, { ...TYPESCRIPT, ...config })
}

async function scan(): Promise<{ exitCode: number; output: string }> {
  const { code, stdout, stderr } = await runCliIn(workspace.root, ["scan", "--no-timestamp"])
  return { exitCode: code, output: `${stderr}${stdout}` }
}

async function scanned(name: string): Promise<IRSymbol> {
  const ir = JSON.parse(
    await readFile(resolve(workspace.root, "out", IR_JSON_FILENAME), "utf8"),
  ) as IR
  return symbolNamed({ ir }, name)
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
  it("applies both a decorator rule and a class-name rule", async () => {
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
    await workspace.writeSource("src/a.ts", SOURCE)

    const { exitCode, output } = await scan()

    expect(exitCode, output).toBe(EXIT.SUCCESS)
    const controller = await scanned("UserController")
    expect(controller.extKind).toBe("framework:hint:acme:controller")
    expect(controller.decorators.map((d) => [d.name, d.boundary])).toEqual([
      ["AcmeController", true],
    ])
    expect((await scanned("OrderHandler")).extKind).toBe("framework:hint:acme:handler")
    expect((await scanned("Secret")).extKind).toBeNull()
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
    await workspace.writeSource("src/a.ts", SOURCE)

    const { exitCode, output } = await scan()

    expect(exitCode, output).toBe(EXIT.SUCCESS)
    const controller = await scanned("UserController")
    expect(controller.dropped).toBe(false)
    expect(controller.decorators[0]?.boundary).toBe(true)
    expect(controller.derivedBy).toContain("framework-hint:acme:controller")
    const secret = await scanned("Secret")
    expect([secret.dropped, secret.dropReason]).toEqual([
      true,
      'frameworkHints "acme": @AcmeInternal',
    ])
    const handler = await scanned("OrderHandler")
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
    await workspace.writeSource(
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

    expect(exitCode, output).toBe(EXIT.SUCCESS)
    const nest = await scanned("UsersHandler")
    expect(nest.extKind).toBe("framework:nestjs:controller")
    expect(nest.decorators[0]?.boundary).toBe(true)
    expect((await scanned("OrderHandler")).extKind).toBe("framework:hint:acme:handler")
  })

  it("refuses two entries that derive the same namespace as a config error naming the entry", async () => {
    await writeConfig({
      frameworkHints: [
        { name: "acme", decorators: { A: { extKind: "framework:acme:a" } } },
        { name: "acme-two", decorators: { B: { extKind: "framework:acme:b" } } },
      ],
    })
    await workspace.writeSource("src/a.ts", "export const x = 1\n")

    const { exitCode, output } = await scan()

    expect(exitCode, output).toBe(EXIT.INPUT_ERROR)
    expect(output).toContain(`frameworkHints entry "acme-two" cannot be registered`)
  })
})

import { readFile } from "node:fs/promises"
import { irSchemaViolations, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { EXIT, runScan } from "../src"
import { TYPESCRIPT, writeConfig, writeTypeScriptWorkspace } from "./workspace"

const workspace = useScratchWorkspace("component-writer")

async function componentsDeclaredAs(
  components: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  await writeTypeScriptWorkspace(workspace.root, "component-writer")
  await writeConfig(workspace.root, { ...TYPESCRIPT, components })
  const report = await runScan({ cwd: workspace.root, format: "json" })
  expect(report.exitCode).toBe(EXIT.SUCCESS)
  const ir = JSON.parse(await readFile(report.irPath ?? "", "utf8")) as Record<string, unknown>
  expect(irSchemaViolations(ir)).toEqual([])
  return ir.components as Record<string, unknown>[]
}

describe("a Component the config declares", () => {
  it("writes description as null, omits the optional arrays it was not given, and defaults languages to ts", async () => {
    const [billing] = await componentsDeclaredAs([{ id: "billing", roots: ["src"] }])

    expect(billing).toStrictEqual({
      id: "billing",
      name: "billing",
      roots: ["src"],
      languages: ["ts"],
      description: null,
    })
  })

  it("keeps the optional arrays and the description the config supplies", async () => {
    const [billing] = await componentsDeclaredAs([
      {
        id: "billing",
        roots: ["src"],
        languages: ["ts"],
        publicApi: ["src/index.ts"],
        frameworks: ["nestjs"],
        description: "Invoicing",
      },
    ])

    expect(billing).toMatchObject({
      publicApi: ["src/index.ts"],
      frameworks: ["nestjs"],
      description: "Invoicing",
    })
  })
})

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import Ajv2020 from "ajv/dist/2020.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import irSchema from "../../../schema/aburi.ir.v1.json" with { type: "json" }
import { runScan } from "../src"

const ajv = new Ajv2020({ strict: false, allErrors: true })
ajv.addSchema(irSchema, "ir")
const validateComponent = ajv.getSchema("ir#/$defs/Component") as (v: unknown) => boolean

let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-component-writer-"))
  await writeFile(
    resolve(scratch, "package.json"),
    JSON.stringify({ name: "component-writer-fixture", private: true }),
    "utf8",
  )
  await mkdir(resolve(scratch, "src"), { recursive: true })
  await writeFile(resolve(scratch, "src/quiet.ts"), "// declares nothing\n", "utf8")
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function scanWithComponents(components: unknown[]): Promise<Record<string, unknown>> {
  await writeFile(
    resolve(scratch, "aburi.json"),
    JSON.stringify({
      $schema: "https://aburi.kage1020.com/schema/aburi.config.v1.json",
      languages: ["lang-typescript"],
      components,
    }),
    "utf8",
  )
  const report = await runScan({
    cwd: scratch,
    outputDir: resolve(scratch, "out"),
    format: "json",
  })
  expect(report.exitCode).toBe(0)
  expect(report.irPath).not.toBeNull()
  return JSON.parse(await readFile(report.irPath as string, "utf8")) as Record<string, unknown>
}

describe("config-declared Components (ir-schema.md)", () => {
  it("writes description as an explicit null and omits the empty Class B arrays", async () => {
    const ir = await scanWithComponents([{ id: "billing", roots: ["src"], languages: ["ts"] }])
    const components = ir.components as Array<Record<string, unknown>>
    expect(components).toHaveLength(1)
    const billing = components[0] as Record<string, unknown>

    expect(Object.hasOwn(billing, "description")).toBe(true)
    expect(billing.description).toBeNull()
    expect(Object.hasOwn(billing, "publicApi")).toBe(false)
    expect(Object.hasOwn(billing, "frameworks")).toBe(false)
  })

  it("keeps the Class B arrays when the config supplies them", async () => {
    const ir = await scanWithComponents([
      {
        id: "billing",
        roots: ["src"],
        languages: ["ts"],
        publicApi: ["src/index.ts"],
        frameworks: ["nestjs"],
        description: "Invoicing",
      },
    ])
    const billing = (ir.components as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    expect(billing.publicApi).toEqual(["src/index.ts"])
    expect(billing.frameworks).toEqual(["nestjs"])
    expect(billing.description).toBe("Invoicing")
  })

  it("falls back to ['ts'] when the config omits languages", async () => {
    const ir = await scanWithComponents([{ id: "billing", roots: ["src"] }])
    const billing = (ir.components as Array<Record<string, unknown>>)[0] as Record<string, unknown>
    expect(billing.languages).toEqual(["ts"])
  })

  it("emits Components that validate against schema/aburi.ir.v1.json", async () => {
    const ir = await scanWithComponents([{ id: "billing", roots: ["src"] }])
    for (const component of ir.components as unknown[]) {
      expect(validateComponent(component), ajv.errorsText(ajv.errors, { separator: "\n" })).toBe(
        true,
      )
    }
  })
})

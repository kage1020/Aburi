import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import Ajv2020 from "ajv/dist/2020.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import irSchema from "../../../schema/aburi.ir.v1.json" with { type: "json" }
import { runScan } from "../src"

/**
 * `resolveComponents` is one of the two writers that produce `Component` records — the
 * other is `detectComponents` in `@aburi/core`, exercised by the e2e suite. The two must
 * agree on shape, because a Component that gains or loses keys depending on whether the
 * user configured it or Aburi detected it turns `aburi diff` into a source of spurious
 * changes on a workspace where nothing moved.
 *
 * Everything here reads the IR back off disk rather than inspecting the in-memory report:
 * `serializeCanonical` drops properties whose value is `undefined`, so an omitted Class A
 * key (ir-schema.md §1.1) is invisible in TypeScript and visible only in the written bytes.
 */

const ajv = new Ajv2020({ strict: false, allErrors: true })
ajv.addSchema(irSchema, "ir")
/**
 * Validates one `components[]` entry rather than the whole document. A whole-document check
 * belongs where a real language plugin is loaded (`@aburi/e2e-integration`): a plugin-less
 * `runScan` writes `workspace.languages: []` against a `minItems: 1` schema, which is a
 * separate defect from anything this file is about and would sit here as unrelated noise.
 */
const validateComponent = ajv.getSchema("ir#/$defs/Component") as (v: unknown) => boolean

let scratch = ""

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "aburi-component-writer-"))
  await writeFile(
    resolve(scratch, "package.json"),
    JSON.stringify({ name: "component-writer-fixture", private: true }),
    "utf8",
  )
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function scanWithComponents(components: unknown[]): Promise<Record<string, unknown>> {
  await writeFile(
    resolve(scratch, "aburi.json"),
    JSON.stringify({ $schema: "https://aburi.dev/schema/aburi.config.v1.json", components }),
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

describe("config-declared Components (ir-schema.md §1.1)", () => {
  it("writes description as an explicit null and omits the empty Class B arrays", async () => {
    const ir = await scanWithComponents([{ id: "billing", roots: ["src"], languages: ["ts"] }])
    const components = ir.components as Array<Record<string, unknown>>
    expect(components).toHaveLength(1)
    const billing = components[0] as Record<string, unknown>

    expect(Object.hasOwn(billing, "description")).toBe(true)
    expect(billing.description).toBeNull()
    // Class B: the empty case is an absent key. `detectComponents` omits these, so writing
    // `[]` here would give the same Component two shapes across the two producers.
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
    // `languages` is optional in the config schema but `minItems: 1` in the IR schema, so
    // the straightforward `entry.languages ?? []` produced a document that failed its own
    // validation -- silently, because nothing validated a generated IR.
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

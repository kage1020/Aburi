import type { ScanResult } from "@aburi/core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { checkoutFixture } from "../src/fixture"
import { irValidator } from "../src/ir-schema"
import { scanFixture } from "../src/scan-helper"

/**
 * Schema conformance for a scanned document, plus the two `workspace.languages` relations
 * the schema cannot state on its own: the field carries `LanguageId`s rather than plugin
 * manifest names, and it covers every `Symbol.language`.
 *
 * One checkout and one scan serve all three assertions — they read the same document and
 * mutate nothing.
 */

let ir: ScanResult["ir"]
let violations: (doc: unknown) => string[]
let cleanup: () => Promise<void>

beforeAll(async () => {
  const fixture = await checkoutFixture()
  cleanup = fixture.cleanup
  violations = await irValidator()
  ir = (await scanFixture(fixture.root)).ir
})

afterAll(async () => {
  await cleanup()
})

describe("e2e: emitted IR validates against schema/aburi.ir.v1.json", () => {
  it("passes ajv for the nestjs-billing fixture", () => {
    expect(violations(ir)).toEqual([])
  })

  it("reports LanguageIds — not plugin manifest names — in workspace.languages", () => {
    expect(ir.workspace.languages).toEqual(["ts"])
    for (const id of ir.workspace.languages) expect(id).toMatch(/^[a-z][a-z0-9]*$/)
  })

  it("keeps every Symbol.language inside workspace.languages", () => {
    const declared = new Set<string>(ir.workspace.languages)
    const used = new Set(ir.symbols.map((s) => s.language))
    expect(used.size).toBeGreaterThan(0)
    for (const language of used) expect(declared.has(language)).toBe(true)
  })
})

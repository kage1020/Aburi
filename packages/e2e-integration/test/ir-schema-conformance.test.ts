import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import Ajv2020, { type ErrorObject } from "ajv/dist/2020"
import { afterEach, describe, expect, it } from "vitest"
import { checkoutFixture } from "../src/fixture"
import { scanFixture } from "../src/scan-helper"

/**
 * The v1 JSON Schemas under `schema/` are frozen and are the stated source of truth for
 * the IR, so a produced IR failing them is a contract break — not a cosmetic one, since
 * downstream consumers that validate would reject every document. The 17 integrity
 * invariants deliberately encode cross-field relationships the schema cannot; they never
 * check the schema itself, which is how `workspace.languages` carrying a plugin manifest
 * name went unnoticed. This test closes that gap for the real scan pipeline.
 */

function repoRoot(): string {
  const here = fileURLToPath(import.meta.url)
  return resolve(dirname(here), "..", "..", "..")
}

async function irValidator(): Promise<(doc: unknown) => ErrorObject[]> {
  const raw = await readFile(resolve(repoRoot(), "schema", "aburi.ir.v1.json"), "utf8")
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  ajv.addFormat("date-time", true)
  const validate = ajv.compile(JSON.parse(raw))
  return (doc: unknown) => (validate(doc) ? [] : (validate.errors ?? []))
}

function describeErrors(errors: readonly ErrorObject[]): string {
  return errors.map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`).join("\n")
}

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (cleanup !== null) {
    await cleanup()
    cleanup = null
  }
})

describe("e2e: emitted IR validates against schema/aburi.ir.v1.json", () => {
  it("passes ajv for the nestjs-billing fixture", async () => {
    const fixture = await checkoutFixture()
    cleanup = fixture.cleanup

    const validate = await irValidator()
    const result = await scanFixture(fixture.root)

    const errors = validate(result.ir)
    expect(describeErrors(errors)).toBe("")
  })

  it("reports LanguageIds — not plugin manifest names — in workspace.languages", async () => {
    const fixture = await checkoutFixture()
    cleanup = fixture.cleanup

    const result = await scanFixture(fixture.root)

    expect(result.ir.workspace.languages).toEqual(["ts"])
    for (const id of result.ir.workspace.languages) expect(id).toMatch(/^[a-z][a-z0-9]*$/)
  })

  it("keeps every Symbol.language inside workspace.languages", async () => {
    const fixture = await checkoutFixture()
    cleanup = fixture.cleanup

    const result = await scanFixture(fixture.root)

    const declared = new Set(result.ir.workspace.languages)
    const used = new Set(result.ir.symbols.map((s) => s.language))
    expect(used.size).toBeGreaterThan(0)
    for (const language of used) expect(declared.has(language)).toBe(true)
  })
})

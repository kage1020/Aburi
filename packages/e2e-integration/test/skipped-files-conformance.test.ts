import type { ScanResult } from "@aburi/core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { checkoutFixture } from "../src/fixture"
import { irValidator } from "../src/ir-schema"
import { scanFixture } from "../src/scan-helper"

/**
 * `stats.skippedFiles[]` on a real document, validated against the published schema.
 *
 * `codegen-drift` proves the generated types match the schema and TypeScript accepts excess
 * properties structurally, so a document that violates `additionalProperties: false` or omits
 * a `required` key type-checks, passes every unit test, and is refused by the first
 * third-party validator that reads it. The conformance suite next door is guaranteed by its
 * own fixture to skip nothing, so until now no validated document carried this array.
 *
 * The cap is set below the size of the fixture's own sources, which is the one way to make a
 * real scan drop real files without breaking any of them.
 */

let result: ScanResult
let violations: (doc: unknown) => string[]
let cleanup: () => Promise<void>

beforeAll(async () => {
  const fixture = await checkoutFixture()
  cleanup = fixture.cleanup
  violations = await irValidator()
  result = await scanFixture(fixture.root, { maxFileSizeBytes: 1024 })
})

afterAll(async () => {
  await cleanup()
})

describe("e2e: a document that lost files still validates", () => {
  it("dropped something, or the rest of this file proves nothing", () => {
    expect(result.ir.stats.skippedFiles?.length ?? 0).toBeGreaterThan(0)
  })

  it("passes ajv with the array present", () => {
    expect(violations(result.ir)).toEqual([])
  })

  it("names the same files the scan reported, and nothing else", () => {
    expect(result.ir.stats.skippedFiles?.map((f) => f.path)).toEqual(
      result.skipped.map((f) => f.path),
    )
  })

  it("carries no detail, though the scan had one for every entry", () => {
    for (const entry of result.ir.stats.skippedFiles ?? []) {
      expect(Object.keys(entry).sort()).toEqual(["path", "reason"])
    }
    expect(result.skipped.every((f) => f.detail !== undefined)).toBe(true)
  })
})

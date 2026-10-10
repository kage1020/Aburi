import type { ScanResult } from "@aburi/core"
import { irSchemaViolations } from "@aburi/test-support"
import { beforeAll, describe, expect, it } from "vitest"
import { scanFixture, useFixtureCheckout } from "./project"

const fixture = useFixtureCheckout("nestjs-billing", "all")

let result: ScanResult

beforeAll(async () => {
  result = await scanFixture(fixture.root, { maxFileSizeBytes: 1024 })
})

describe("e2e: a document that lost files still validates", () => {
  it("dropped something, or the rest of this file proves nothing", () => {
    expect(result.ir.stats.skippedFiles?.length ?? 0).toBeGreaterThan(0)
  })

  it("passes ajv with the array present", () => {
    expect(irSchemaViolations(result.ir)).toEqual([])
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

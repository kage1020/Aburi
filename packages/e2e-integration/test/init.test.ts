import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { runInit } from "@aburi/cli"
import { afterEach, describe, expect, it } from "vitest"
import { checkoutFixture } from "../src/fixture"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (cleanup !== null) {
    await cleanup()
    cleanup = null
  }
})

describe("e2e: aburi init on fixtures/nestjs-billing", () => {
  it("autodetects nestjs-billing as one TypeScript / NestJS component", async () => {
    const fixture = await checkoutFixture()
    cleanup = fixture.cleanup

    const report = await runInit({ cwd: fixture.root })

    expect(report.exitCode).toBe(0)
    expect(report.overwrote).toBe(false)
    expect(report.detectedLanguages).toContain("ts")
    expect(report.detectedFrameworks).toContain("nestjs")
    // pnpm-lock.yaml is absent in the fixture, so the manager list should be empty
    // rather than incorrectly claiming a package manager for the copied tree.
    expect(report.detectedManagers).toEqual([])
    // The fixture is a single NestJS component (no monorepo), so autodetect should
    // land on exactly one Component covering the whole tree.
    expect(report.componentCount).toBe(1)
  })

  it("writes an aburi.json referencing the canonical config schema", async () => {
    const fixture = await checkoutFixture()
    cleanup = fixture.cleanup

    await runInit({ cwd: fixture.root })

    const raw = await readFile(resolve(fixture.root, "aburi.json"), "utf8")
    const parsed = JSON.parse(raw) as {
      $schema: string
      languages: string[]
      frameworks: string[]
      components: readonly {
        id: string
        name: string
        roots: string[]
        languages: string[]
        frameworks: string[]
      }[]
    }
    expect(parsed.$schema).toBe("https://aburi.dev/schema/aburi.config.v1.json")
    expect(parsed.languages).toContain("ts")
    expect(parsed.frameworks).toContain("nestjs")
    expect(parsed.components).toHaveLength(1)
    const [component] = parsed.components
    expect(component).toBeDefined()
    expect(component?.languages).toContain("ts")
    expect(component?.frameworks).toContain("nestjs")
  })

  it("refuses to overwrite an existing aburi.json without --force", async () => {
    const fixture = await checkoutFixture()
    cleanup = fixture.cleanup

    await runInit({ cwd: fixture.root })
    // Second invocation without --force must throw with an input-error contract
    // (CLI maps that to EXIT.INPUT_ERROR = 2 upstream).
    await expect(runInit({ cwd: fixture.root })).rejects.toThrow(/already exists/)
  })

  it("overwrites the existing config when --force is set", async () => {
    const fixture = await checkoutFixture()
    cleanup = fixture.cleanup

    await runInit({ cwd: fixture.root })
    const second = await runInit({ cwd: fixture.root, force: true })
    expect(second.exitCode).toBe(0)
    expect(second.overwrote).toBe(true)
  })
})

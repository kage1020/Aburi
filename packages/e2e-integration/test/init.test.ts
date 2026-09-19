import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { runInit } from "@aburi/cli"
import { describe, expect, it } from "vitest"
import { useFixtureCheckout } from "../src/fixture"

const fixture = useFixtureCheckout()

describe("e2e: aburi init on fixtures/nestjs-billing", () => {
  it("autodetects nestjs-billing as one TypeScript / NestJS component", async () => {
    const report = await runInit({ cwd: fixture.root })

    expect(report.exitCode).toBe(0)
    expect(report.overwrote).toBe(false)
    expect(report.detectedLanguages).toContain("ts")
    expect(report.detectedFrameworks).toContain("nestjs")
    // pnpm-lock.yaml is absent in the fixture, so no package manager may be claimed.
    expect(report.detectedManagers).toEqual([])
    // A single NestJS component (no monorepo): exactly one Component covering the tree.
    expect(report.componentCount).toBe(1)
  })

  it("writes an aburi.json referencing the canonical config schema", async () => {
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
    expect(parsed.$schema).toBe("https://aburi.kage1020.com/schema/aburi.config.v1.json")
    // Top-level `languages` / `frameworks` are PluginRefs the loader resolves as module
    // specifiers; `components[].languages` stays in the LanguageId vocabulary.
    expect(parsed.languages).toContain("lang-typescript")
    expect(parsed.frameworks).toContain("framework-nestjs")
    expect(parsed.components).toHaveLength(1)
    const [component] = parsed.components
    expect(component).toBeDefined()
    expect(component?.languages).toContain("ts")
    expect(component?.frameworks).toContain("nestjs")
  })

  it("refuses to overwrite an existing aburi.json without --force", async () => {
    await runInit({ cwd: fixture.root })
    // An input-error contract; the CLI maps it to EXIT.INPUT_ERROR upstream.
    await expect(runInit({ cwd: fixture.root })).rejects.toThrow(/already exists/)
  })

  it("overwrites the existing config when --force is set", async () => {
    await runInit({ cwd: fixture.root })
    const second = await runInit({ cwd: fixture.root, force: true })
    expect(second.exitCode).toBe(0)
    expect(second.overwrote).toBe(true)
  })
})

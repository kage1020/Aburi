import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { runInit } from "../../src"
import { useFixtureCheckout } from "./project"

const fixture = useFixtureCheckout()

describe("e2e: aburi init on fixtures/nestjs-billing", () => {
  it("autodetects one TypeScript / NestJS component and writes the plugins it needs", async () => {
    const report = await runInit({ cwd: fixture.root })

    expect(report.exitCode).toBe(0)
    expect(report.detectedLanguages).toContain("ts")
    expect(report.detectedFrameworks).toContain("nestjs")
    // pnpm-lock.yaml is absent in the fixture, so no package manager may be claimed.
    expect(report.detectedManagers).toEqual([])
    expect(report.componentCount).toBe(1)
    const config = JSON.parse(await readFile(report.outputPath, "utf8")) as {
      languages: string[]
      frameworks: string[]
      components: { languages: string[]; frameworks: string[] }[]
    }
    expect(config.languages).toContain("lang-typescript")
    expect(config.frameworks).toContain("framework-nestjs")
    expect(config.components).toEqual([
      expect.objectContaining({
        languages: expect.arrayContaining(["ts"]),
        frameworks: expect.arrayContaining(["nestjs"]),
      }),
    ])
  })
})

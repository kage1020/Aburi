import { readFile } from "node:fs/promises"
import { irSchemaViolations, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { runInit, runScan } from "../../src"
import { useFixtureCheckout } from "./project"

const fixture = useFixtureCheckout()
const output = useScratchWorkspace("init-scan")

describe("e2e: `aburi init` output is loadable by `aburi scan`", () => {
  it("scans the fixture using only the config init produced", async () => {
    const init = await runInit({ cwd: fixture.root })
    expect(init.exitCode).toBe(0)
    expect(init.unmappedLanguages).toEqual([])

    const report = await runScan({ cwd: fixture.root, outputDir: output.root, format: "json" })

    expect(report.keptSymbols).toBeGreaterThan(0)
    expect(report.skipped).toEqual([])
    expect(report.parseErrorCount).toBe(0)

    expect(report.irPath).not.toBeNull()
    const written: unknown = JSON.parse(await readFile(report.irPath as string, "utf8"))
    expect(irSchemaViolations(written)).toEqual([])
  })
})

import { readFile } from "node:fs/promises"
import { runInit, runScan } from "@aburi/cli"
import { describe, expect, it } from "vitest"
import { useFixtureCheckout } from "../src/fixture"
import { irValidator } from "../src/ir-schema"
import { useScratchWorkspace } from "../src/scratch"

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
    const validate = await irValidator()
    expect(validate(written)).toEqual([])
  })
})

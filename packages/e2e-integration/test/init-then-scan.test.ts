import { readFile } from "node:fs/promises"
import { runInit, runScan } from "@aburi/cli"
import { describe, expect, it } from "vitest"
import { useFixtureCheckout } from "../src/fixture"
import { irValidator } from "../src/ir-schema"
import { useScratchWorkspace } from "../src/scratch"

/**
 * The README quick start is `aburi init` followed by `aburi scan`, and this is the only
 * place the two run against each other. `scan-helper.ts` injects plugin objects directly,
 * so it never reaches `loadPlugins` — the code that turns a `config.languages` entry into a
 * module specifier — and so it cannot tell whether `init` wrote something loadable.
 *
 * Plugin resolution is anchored to the CLI module rather than to the scanned workspace,
 * which is why the first-party plugins are devDependencies of `@aburi/cli`. The same
 * anchoring works for a consumer on npm or yarn, where plugins are hoisted alongside the
 * CLI, but not for pnpm's isolated layout — so a pnpm resolution failure cannot surface
 * from this test.
 */

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

    // The document the loader-resolved plugin set produced, read back off disk. The
    // conformance suite validates the injected plugin set; this validates the real lineup.
    expect(report.irPath).not.toBeNull()
    const written: unknown = JSON.parse(await readFile(report.irPath as string, "utf8"))
    const validate = await irValidator()
    expect(validate(written)).toEqual([])
  })
})

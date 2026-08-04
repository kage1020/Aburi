import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { runInit, runScan } from "@aburi/cli"
import { describe, expect, it } from "vitest"
import { checkoutFixture } from "../src/fixture"
import { irValidator } from "../src/ir-schema"

/**
 * The README quick start is `aburi init` followed by `aburi scan`, and this is the only
 * place the two run against each other. `scan-helper.ts` injects plugin objects directly,
 * so it never reaches `loadPlugins` — the code that turns a `config.languages` entry into a
 * module specifier — and so it cannot tell whether `init` wrote something loadable.
 *
 * Plugin resolution is anchored to the CLI module rather than to the scanned workspace,
 * which is why the first-party plugins are devDependencies of `@aburi/cli`: it is what
 * makes that path reachable inside the monorepo. The same anchoring works for a consumer on
 * npm or yarn, where plugins are hoisted alongside the CLI. It does not hold for pnpm's
 * default isolated layout — a consumer's `@aburi/lang-typescript` is not visible from
 * `@aburi/cli`'s own `node_modules` there — so a pnpm resolution failure cannot surface
 * from this test.
 */

describe("e2e: `aburi init` output is loadable by `aburi scan`", () => {
  it("scans the fixture using only the config init produced", async () => {
    const fixture = await checkoutFixture()
    const outDir = await mkdtemp(resolve(tmpdir(), "aburi-init-scan-"))
    try {
      const init = await runInit({ cwd: fixture.root })
      expect(init.exitCode).toBe(0)
      expect(init.unmappedLanguages).toEqual([])

      const report = await runScan({ cwd: fixture.root, outputDir: outDir, format: "json" })

      expect(report.keptSymbols).toBeGreaterThan(0)
      expect(report.skipped).toEqual([])
      expect(report.parseErrorCount).toBe(0)

      // The document the loader-resolved plugin set produced, read back off disk. The
      // conformance suite validates the injected plugin set, so without this the real
      // lineup falls between the two tests unvalidated.
      expect(report.irPath).not.toBeNull()
      const written: unknown = JSON.parse(await readFile(report.irPath as string, "utf8"))
      const validate = await irValidator()
      expect(validate(written)).toEqual([])
    } finally {
      await rm(outDir, { recursive: true, force: true })
      await fixture.cleanup()
    }
  })
})

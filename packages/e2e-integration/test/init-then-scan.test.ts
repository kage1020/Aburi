import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { runInit, runScan } from "@aburi/cli"
import { afterEach, describe, expect, it } from "vitest"
import { checkoutFixture } from "../src/fixture"

/**
 * The README quick start is `aburi init` followed by `aburi scan`, and until now nothing
 * exercised it: `scan-helper.ts` injects plugin objects directly, so the real
 * `loadPlugins` path — the one that turns `config.languages` entries into module
 * specifiers — was never reached from a config that `init` actually wrote. That is how
 * `init` came to emit detector ids (`ts`) into a field the loader reads as a plugin ref
 * (`@aburi/ts`, which does not exist).
 *
 * Plugin resolution happens relative to the CLI module, not the scanned workspace, so
 * the first-party plugins are devDependencies of `@aburi/cli` purely to make this path
 * reachable inside the monorepo. A published install gets the same resolution from the
 * consumer's own `node_modules`.
 */

let cleanup: (() => Promise<void>) | null = null
let outDir = ""

afterEach(async () => {
  if (cleanup !== null) {
    await cleanup()
    cleanup = null
  }
  if (outDir !== "") {
    await rm(outDir, { recursive: true, force: true })
    outDir = ""
  }
})

describe("e2e: `aburi init` output is loadable by `aburi scan`", () => {
  it("scans the fixture using only the config init produced", async () => {
    const fixture = await checkoutFixture()
    cleanup = fixture.cleanup
    outDir = await mkdtemp(resolve(tmpdir(), "aburi-init-scan-"))

    const init = await runInit({ cwd: fixture.root })
    expect(init.exitCode).toBe(0)

    const report = await runScan({ cwd: fixture.root, outputDir: outDir, format: "json" })

    expect(report.keptSymbols).toBeGreaterThan(0)
    expect(report.skipped).toEqual([])
    expect(report.parseErrorCount).toBe(0)
  })
})

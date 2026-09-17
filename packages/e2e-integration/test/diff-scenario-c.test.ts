import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { evaluateFailOn, parseFailOn } from "@aburi/cli"
import { describe, expect, it } from "vitest"
import { useFixtureCheckout } from "../src/fixture"
import { diffIRs, scanFixture } from "../src/scan-helper"

/**
 * Scenario C — `common/logger.service.ts` moves under a new `common/logging/` subdirectory
 * and every import is updated; the LoggerService class is byte-identical after the move.
 * The 5-stage matcher should pair each pre/post Symbol via the logic-fingerprint stage
 * (stage 3): the id changes because it embeds the file path, but the logic fingerprint is
 * invariant to file location. A plain rename must never gate.
 */

const fixture = useFixtureCheckout()

describe("e2e diff — scenario C: logger.service.ts moves under common/logging/", () => {
  it("classifies the move as moved:N with no add/remove/changed and does not trip a removed/dropped-toggled gate", async () => {
    const baseIR = (await scanFixture(fixture.root)).ir

    const oldPath = resolve(fixture.root, "src/common/logger.service.ts")
    const newPath = resolve(fixture.root, "src/common/logging/logger.service.ts")
    const original = await readFile(oldPath, "utf8")
    await mkdir(dirname(newPath), { recursive: true })
    await writeFile(newPath, original, "utf8")
    await rm(oldPath)

    for (const importer of [
      resolve(fixture.root, "src/app.module.ts"),
      resolve(fixture.root, "src/billing/billing.service.ts"),
    ]) {
      const source = await readFile(importer, "utf8")
      const rewritten = source.replace(
        /["'](.+?)common\/logger\.service["']/g,
        (_match, prefix) => `"${prefix}common/logging/logger.service"`,
      )
      expect(
        rewritten,
        `import rewrite must match a common/logger.service ref in ${importer}`,
      ).not.toBe(source)
      await writeFile(importer, rewritten, "utf8")
    }

    const headIR = (await scanFixture(fixture.root)).ir
    const diff = diffIRs(baseIR, headIR)

    expect(diff.summary.moved).toBeGreaterThan(0)
    expect(diff.summary.added).toBe(0)
    expect(diff.summary.removed).toBe(0)
    // The logger's Symbols still exist in the head, just under a different source.file, so a
    // drop toggle here would be a matching bug.
    expect(diff.summary.droppedToggled).toBe(0)

    // Every moved Symbol must originate from the logger service; a move reported elsewhere
    // would be a fingerprint collision.
    const moved = diff.symbols.filter((c) => c.status === "moved" || c.status === "moved+changed")
    expect(moved.length).toBeGreaterThan(0)
    for (const change of moved) {
      expect(
        change.before.source.file,
        `moved symbol ${change.before.id} should originate from the old logger.service.ts path`,
      ).toMatch(/common\/logger\.service\.ts$/)
    }

    const triggered = evaluateFailOn(parseFailOn("removed,dropped-toggled"), diff)
    expect(triggered.firstTriggered).toBeNull()
  })
})

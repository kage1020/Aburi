import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { evaluateFailOn, parseFailOn } from "@aburi/cli"
import { buildDiff } from "@aburi/diff"
import { afterEach, describe, expect, it } from "vitest"
import { checkoutFixture } from "../src/fixture"
import { scanFixture } from "../src/scan-helper"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (cleanup !== null) {
    await cleanup()
    cleanup = null
  }
})

/**
 * Scenario C — the developer relocates `common/logger.service.ts` under a new
 * `common/logging/` subdirectory and updates every import. No behaviour changes:
 * the LoggerService class is identical byte-for-byte after the move. The 5-stage
 * matcher should pair each pre/post Symbol via the logic-fingerprint stage
 * (stage 3) — the id changes because it embeds the file path, so stage 1 fails,
 * but the logic fingerprint is invariant to file location.
 *
 * Expected diff summary: `moved: N > 0`, `changed: 0`, `added: 0`, `removed: 0`.
 * `--fail-on removed,dropped-toggled` must NOT trip because neither category
 * fires — a plain rename should never gate.
 */
describe("e2e diff — scenario C: logger.service.ts moves under common/logging/", () => {
  it("classifies the move as moved:N with no add/remove/changed and does not trip a removed/dropped-toggled gate", async () => {
    const fixture = await checkoutFixture()
    cleanup = fixture.cleanup

    const baseIR = (await scanFixture(fixture.root)).ir

    // Head mutation: move common/logger.service.ts → common/logging/logger.service.ts
    // and update every importer (app.module.ts, billing.service.ts).
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
      const src = await readFile(importer, "utf8")
      const rewritten = src.replace(
        /["'](.+?)common\/logger\.service["']/g,
        (_match, prefix) => `"${prefix}common/logging/logger.service"`,
      )
      expect(
        rewritten,
        `import rewrite must match a common/logger.service ref in ${importer}`,
      ).not.toBe(src)
      await writeFile(importer, rewritten, "utf8")
    }

    const headIR = (await scanFixture(fixture.root)).ir

    const irSchema = "https://aburi.dev/schema/aburi.ir.v1.json"
    const diff = buildDiff({
      baseIR,
      headIR,
      base: { ref: "base", irSchema },
      head: { ref: "head", irSchema },
    })

    expect(diff.summary.moved).toBeGreaterThan(0)
    expect(diff.summary.added).toBe(0)
    expect(diff.summary.removed).toBe(0)
    // A move triggers no drop toggle: the logger's Symbols still exist in the head,
    // just under a different source.file. If dropped-toggled ever fires here we
    // have a matching bug — the class Symbol and its methods should stage-3-match
    // by logic fingerprint even though their ids embed the moved file path.
    expect(diff.summary.droppedToggled).toBe(0)

    // Every moved Symbol must originate from the logger service. A false-positive
    // move elsewhere (e.g. a service class matched across the rename) would be a
    // fingerprint collision — worth catching here.
    const moved = diff.symbols.filter((c) => c.status === "moved" || c.status === "moved+changed")
    expect(moved.length).toBeGreaterThan(0)
    for (const change of moved) {
      const before = change.status === "moved" ? change.before : change.before
      expect(
        before.source.file,
        `moved symbol ${before.id} should originate from the old logger.service.ts path`,
      ).toMatch(/common\/logger\.service\.ts$/)
    }

    // Gate assertion: `--fail-on removed,dropped-toggled` must NOT trip on a
    // pure move. If it does, either matching stages 1-4 are letting a mover fall
    // through to remove/add, or dropped propagation is spurious.
    const gate = parseFailOn("removed,dropped-toggled")
    const triggered = evaluateFailOn(gate, diff)
    expect(triggered.firstTriggered).toBeNull()
  })
})

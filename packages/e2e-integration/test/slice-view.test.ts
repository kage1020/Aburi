import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { buildDiff } from "@aburi/diff"
import { projectDiff } from "@aburi/markdown-projection"
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
 * Slice View e2e — the "3-layer feature addition" scenario. Starts from the
 * empty `slice-view-3layer` fixture (three placeholder files with no
 * top-level functions), then rewrites the three files to a
 * Controller → Service → Repository chain where the caller in each layer
 * imports and calls the next.
 *
 * Expected shape:
 *   ctl.ts#handleRequest        (added)  ─┐
 *   svc.ts#saveRecordService    (added)  ─┼─ one Slice, members ascending
 *   repo.ts#writeRecord         (added)  ─┘
 *
 * The design-doc requirement: a feature addition touching 3 layers must
 * produce 1 slice, not 3 scattered rows. This test asserts exactly that —
 * one Slice, all three members, no bridging, no phantom cluster, and the
 * Markdown projection carries a `## 🧵 Slice View` section with the three
 * members rendered as one bullet block.
 */
const REPO_HEAD = `export function writeRecord(input: { amount: number }): { id: string; amount: number } {
  return { id: "r1", amount: input.amount }
}
`

const SVC_HEAD = `import { writeRecord } from "./repo"

export function saveRecordService(amount: number): { id: string; amount: number } {
  return writeRecord({ amount })
}
`

const CTL_HEAD = `import { saveRecordService } from "./svc"

export function handleRequest(payload: { amount: number }): { ok: boolean; id: string } {
  const record = saveRecordService(payload.amount)
  return { ok: true, id: record.id }
}
`

describe("e2e slice-view — 3-layer feature addition clusters into 1 slice", () => {
  it("clusters ctl.handleRequest → svc.saveRecordService → repo.writeRecord as one Slice with 3 members", async () => {
    const fixture = await checkoutFixture("slice-view-3layer")
    cleanup = fixture.cleanup

    // 1. baseline scan — three placeholder files with no top-level functions.
    const baseScan = await scanFixture(fixture.root)

    // 2. write the head-side chain, then scan again.
    const repoPath = resolve(fixture.root, "src/repo.ts")
    const svcPath = resolve(fixture.root, "src/svc.ts")
    const ctlPath = resolve(fixture.root, "src/ctl.ts")
    await writeFile(repoPath, REPO_HEAD, "utf8")
    await writeFile(svcPath, SVC_HEAD, "utf8")
    await writeFile(ctlPath, CTL_HEAD, "utf8")
    const headScan = await scanFixture(fixture.root)

    // Sanity: head IR must expose the three new top-level Symbols so the
    // downstream Slice View clustering has three Nodes to work with.
    const repoWrite = headScan.ir.symbols.find((s) => s.id.endsWith("repo.ts#writeRecord"))
    const svcSave = headScan.ir.symbols.find((s) => s.id.endsWith("svc.ts#saveRecordService"))
    const ctlHandle = headScan.ir.symbols.find((s) => s.id.endsWith("ctl.ts#handleRequest"))
    expect(repoWrite, "head scan should discover repo.writeRecord").toBeDefined()
    expect(svcSave, "head scan should discover svc.saveRecordService").toBeDefined()
    expect(ctlHandle, "head scan should discover ctl.handleRequest").toBeDefined()

    // 3. diff base vs head — this is the pipeline `aburi diff` uses.
    const diff = buildDiff({
      baseIR: baseScan.ir,
      headIR: headScan.ir,
      base: { ref: "base", irSchema: baseScan.ir.$schema },
      head: { ref: "head", irSchema: headScan.ir.$schema },
    })

    // 4. Exactly one Slice, containing all three added Symbols in ascending id
    //    order, anchored by the lex-smallest member.
    expect(diff.slices).toHaveLength(1)
    const slice = diff.slices[0]
    if (slice === undefined) throw new Error("unreachable: length 1 checked above")
    const memberIds = [ctlHandle?.id ?? "", repoWrite?.id ?? "", svcSave?.id ?? ""].sort()
    expect(slice.members).toEqual(memberIds)
    expect(slice.id).toBe(`slice:${memberIds[0]}`)

    // 5. Markdown side: the `## 🧵 Slice View` section is present and names
    //    every member. Contain-checks must be scoped to the Slice View
    //    subsection because the flat `## ➕ Added` section also lists the
    //    same three symbols (Slice View is additive per slice-view.md §14.10),
    //    and a naive `md.toContain("handleRequest")` would pass even if the
    //    Slice View rendering broke entirely.
    const md = projectDiff(diff)
    expect(md).toContain("➕ Added")
    const sliceStart = md.indexOf("🧵 Slice View")
    const nextSectionStart = md.indexOf("\n## ", sliceStart + 1)
    expect(sliceStart).toBeGreaterThan(0)
    expect(nextSectionStart).toBeGreaterThan(sliceStart)
    const sliceSection = md.slice(sliceStart, nextSectionStart)
    expect(sliceSection).toContain(slice.id)
    expect(sliceSection).toContain("handleRequest")
    expect(sliceSection).toContain("saveRecordService")
    expect(sliceSection).toContain("writeRecord")
    expect(sliceSection).toContain("(3 members)")

    // 6. Every call in this chain resolves, so §12.6's marker must stay silent.
    //    A false-positive warning here would train reviewers to ignore it.
    expect(sliceSection).not.toContain("unresolved call")
    expect(headScan.ir.stats.callResolution?.unresolved).toEqual({
      localScope: 0,
      external: 0,
      dynamic: 0,
      ambiguous: 0,
      noMatch: 0,
    })
  })

  it("marks the singleton a dynamic-dispatch call splits off (issue acceptance case)", async () => {
    const fixture = await checkoutFixture("slice-view-3layer")
    cleanup = fixture.cleanup

    const baseScan = await scanFixture(fixture.root)

    // Same three-layer feature, except the controller reaches the service
    // through a factory call. Normalization collapses `getService().save(...)`
    // to the target `getService.save`, the resolver declines it, and the
    // Controller → Service edge never exists — so the reviewer sees singletons.
    await writeFile(resolve(fixture.root, "src/repo.ts"), REPO_HEAD, "utf8")
    await writeFile(resolve(fixture.root, "src/svc.ts"), SVC_HEAD, "utf8")
    await writeFile(
      resolve(fixture.root, "src/ctl.ts"),
      `export function handleRequest(payload: { amount: number }): { ok: boolean } {
  getService().saveRecordService(payload.amount)
  return { ok: true }
}
`,
      "utf8",
    )
    const headScan = await scanFixture(fixture.root)

    expect(headScan.ir.stats.callResolution?.unresolved.dynamic).toBeGreaterThan(0)
    expect(headScan.unresolvedCalls.some((d) => d.bucket === "dynamic")).toBe(true)

    const diff = buildDiff({
      baseIR: baseScan.ir,
      headIR: headScan.ir,
      base: { ref: "base", irSchema: baseScan.ir.$schema },
      head: { ref: "head", irSchema: headScan.ir.$schema },
    })

    // The controller is now its own Slice: the reviewer sees a singleton that
    // looks architecturally disconnected but is not. slice-view.md §12.6 is the
    // marker that tells the two apart.
    const ctlSlice = diff.slices.find(
      (s) => s.members.length === 1 && s.members[0]?.endsWith("ctl.ts#handleRequest") === true,
    )
    expect(ctlSlice, "the unresolved call should split the controller off").toBeDefined()

    const md = projectDiff(diff)
    const sliceStart = md.indexOf("🧵 Slice View")
    const nextSectionStart = md.indexOf("\n## ", sliceStart + 1)
    const sliceSection = md.slice(sliceStart, nextSectionStart)
    expect(sliceSection).toContain("the resolver could not identify")
    // Two call sites, both unresolved: the factory `getService()` itself
    // (`no-match` — nothing in the workspace declares it) and the method
    // invoked on its result (`dynamic`).
    expect(sliceSection).toContain("⚠ 2 unresolved calls")
  })
})

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
 * Slice View e2e (#30) — the "3-layer feature addition" scenario from the
 * issue body. Starts from the empty `slice-view-3layer` fixture (three
 * placeholder files with no top-level functions), then rewrites the three
 * files to a Controller → Service → Repository chain where the caller in
 * each layer imports and calls the next.
 *
 * Expected shape:
 *   ctl.ts#handleRequest        (added)  ─┐
 *   svc.ts#saveRecordService    (added)  ─┼─ one Slice, members ascending
 *   repo.ts#writeRecord         (added)  ─┘
 *
 * The design-doc requirement (issue #30 body): "a feature addition touching
 * 3 layers should produce 1 slice, not 3 scattered rows." This test asserts
 * exactly that — one Slice, all three members, no bridging, no phantom
 * cluster, and the Markdown projection carries a `## 🧵 Slice View` section
 * with the three members rendered as one bullet block.
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
    //    every member; the flat `## ➕ Added` still lists the three symbols too
    //    (Slice View is additive per slice-view.md §14.10).
    const md = projectDiff(diff)
    expect(md).toContain("🧵 Slice View")
    expect(md).toContain(slice.id)
    expect(md).toContain("handleRequest")
    expect(md).toContain("saveRecordService")
    expect(md).toContain("writeRecord")
    expect(md).toContain("➕ Added")
  })
})

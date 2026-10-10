import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { projectDiff } from "@aburi/markdown-projection"
import { diffIRs } from "@aburi/test-harness"
import { symbolById } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { scanFixture, useFixtureCheckout } from "./project"

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

const fixture = useFixtureCheckout("slice-view-3layer")

async function writeHead(files: { repo: string; svc: string; ctl: string }): Promise<void> {
  await writeFile(resolve(fixture.root, "src/repo.ts"), files.repo, "utf8")
  await writeFile(resolve(fixture.root, "src/svc.ts"), files.svc, "utf8")
  await writeFile(resolve(fixture.root, "src/ctl.ts"), files.ctl, "utf8")
}

function sliceViewSection(md: string): string {
  const start = md.indexOf("🧵 Slice View")
  const nextSectionStart = md.indexOf("\n## ", start + 1)
  expect(start).toBeGreaterThan(0)
  expect(nextSectionStart).toBeGreaterThan(start)
  return md.slice(start, nextSectionStart)
}

describe("e2e slice-view — 3-layer feature addition clusters into 1 slice", () => {
  it("clusters ctl.handleRequest → svc.saveRecordService → repo.writeRecord as one Slice with 3 members", async () => {
    const baseScan = await scanFixture(fixture.root)
    await writeHead({ repo: REPO_HEAD, svc: SVC_HEAD, ctl: CTL_HEAD })
    const headScan = await scanFixture(fixture.root)

    const repoWrite = symbolById(headScan, "ts:src/repo.ts#writeRecord")
    const svcSave = symbolById(headScan, "ts:src/svc.ts#saveRecordService")
    const ctlHandle = symbolById(headScan, "ts:src/ctl.ts#handleRequest")

    const diff = diffIRs(baseScan.ir, headScan.ir)

    expect(diff.slices).toHaveLength(1)
    const slice = diff.slices[0]
    if (slice === undefined) throw new Error("unreachable: length 1 checked above")
    const memberIds = [ctlHandle.id, repoWrite.id, svcSave.id].sort()
    expect(slice.members).toEqual(memberIds)
    expect(slice.id).toBe(`slice:${memberIds[0]}`)

    const md = projectDiff(diff)
    expect(md).toContain("➕ Added")
    const section = sliceViewSection(md)
    expect(section).toContain(slice.id)
    expect(section).toContain("handleRequest")
    expect(section).toContain("saveRecordService")
    expect(section).toContain("writeRecord")
    expect(section).toContain("(3 members)")

    expect(section).not.toContain("unresolved call")
    expect(headScan.ir.stats.callResolution?.unresolved).toEqual({
      localScope: 0,
      external: 0,
      dynamic: 0,
      ambiguous: 0,
      noMatch: 0,
    })
  })

  it("marks the singleton a dynamic-dispatch call splits off (issue acceptance case)", async () => {
    const baseScan = await scanFixture(fixture.root)

    await writeHead({
      repo: REPO_HEAD,
      svc: SVC_HEAD,
      ctl: `export function handleRequest(payload: { amount: number }): { ok: boolean } {
  getService().saveRecordService(payload.amount)
  return { ok: true }
}
`,
    })
    const headScan = await scanFixture(fixture.root)

    expect(headScan.ir.stats.callResolution?.unresolved.dynamic).toBeGreaterThan(0)
    expect(headScan.unresolvedCalls.some((call) => call.bucket === "dynamic")).toBe(true)

    const diff = diffIRs(baseScan.ir, headScan.ir)

    const ctlSlice = diff.slices.find(
      (s) => s.members.length === 1 && s.members[0]?.endsWith("ctl.ts#handleRequest") === true,
    )
    expect(ctlSlice, "the unresolved call should split the controller off").toBeDefined()

    const section = sliceViewSection(projectDiff(diff))
    expect(section).toContain("the resolver could not identify")
    expect(section).toContain("⚠ 2 unresolved calls")
  })
})

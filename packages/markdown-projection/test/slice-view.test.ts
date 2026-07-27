import type { SliceRecord, SymbolChange } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src/diff"
import { fp, makeDiff, makeSymbol } from "./fixtures"

/**
 * Slice View rendering acceptance tests. Backs docs/design/slice-view.md §12
 * and SV19–SV20 of §13. The pass-side clustering itself is exercised in
 * `packages/diff/test/slice.test.ts`; here we only assert the Markdown
 * projection: section placement, per-Slice bullet shape, singleton fold,
 * empty-section omission.
 */

const changedSym = (id: string, name: string, file: string, line = 10): SymbolChange => ({
  status: "changed",
  before: makeSymbol({ id, name, source: baseSource(file, line) }),
  after: makeSymbol({
    id,
    name,
    source: baseSource(file, line),
    fingerprint: fp(id),
  }),
  delta: {
    apiChanged: false,
    logicChanged: true,
    syntaxChanged: false,
    componentChanged: false,
    visibilityChanged: false,
  },
})

const addedSym = (id: string, name: string, file: string, line = 15): SymbolChange => ({
  status: "added",
  symbol: makeSymbol({ id, name, source: baseSource(file, line) }),
})

const baseSource = (file: string, startLine: number) => ({
  file,
  startLine,
  endLine: startLine + 5,
  startColumn: null,
  endColumn: null,
})

const slice = (id: string, members: string[]): SliceRecord => ({ id, members })

describe("Slice View Markdown projection — §12", () => {
  it("§12.5 / SV19: an empty slices[] omits the entire section from diff.md", () => {
    const md = projectDiff(makeDiff({ slices: [] }))
    expect(md).not.toContain("Slice View")
    expect(md).not.toContain("🧵")
  })

  it("§12.1: Slice View section appears between Logic changes and Added", () => {
    const ctlId = "ts:src/ctl.ts#Ctl.route"
    const svcId = "ts:src/svc.ts#Svc.op"
    const addedId = "ts:src/add.ts#addedFn"
    const md = projectDiff(
      makeDiff({
        summary: {
          added: 1,
          removed: 0,
          moved: 0,
          movedChanged: 0,
          changed: 2,
          droppedToggled: 0,
          unchanged: 0,
          droppedAdded: 0,
          droppedRemoved: 0,
          componentsAdded: 0,
          componentsRemoved: 0,
          componentsChanged: 0,
          depsAdded: 0,
          depsRemoved: 0,
        },
        symbols: [
          changedSym(ctlId, "Ctl.route", "src/ctl.ts"),
          changedSym(svcId, "Svc.op", "src/svc.ts"),
          addedSym(addedId, "addedFn", "src/add.ts"),
        ],
        slices: [slice(`slice:${ctlId}`, [ctlId, svcId])],
      }),
    )
    const logicIdx = md.indexOf("🔧 Logic changes")
    const sliceIdx = md.indexOf("🧵 Slice View")
    const addedIdx = md.indexOf("➕ Added")
    expect(logicIdx).toBeGreaterThan(0)
    expect(sliceIdx).toBeGreaterThan(logicIdx)
    expect(addedIdx).toBeGreaterThan(sliceIdx)
  })

  it("§12.2: multi-member Slice heading includes full sliceId and member count", () => {
    const ctlId = "ts:src/ctl.ts#Ctl.route"
    const svcId = "ts:src/svc.ts#Svc.op"
    const repoId = "ts:src/repo.ts#Repo.save"
    const md = projectDiff(
      makeDiff({
        symbols: [
          changedSym(ctlId, "Ctl.route", "src/ctl.ts", 42),
          changedSym(svcId, "Svc.op", "src/svc.ts", 88),
          addedSym(repoId, "Repo.save", "src/repo.ts", 15),
        ],
        slices: [slice(`slice:${ctlId}`, [ctlId, repoId, svcId])],
      }),
    )
    expect(md).toContain(`### \`slice:${ctlId}\` (3 members)`)
    // Each member appears with short qname, file:line, and status label.
    expect(md).toContain("`Ctl.route`")
    expect(md).toContain("`src/ctl.ts:42`")
    expect(md).toContain("*(changed)*")
    expect(md).toContain("*(added)*")
    expect(md).toContain("`Repo.save`")
  })

  it("§12.2: Slices are separated by a --- thematic break", () => {
    const A = "ts:src/a.ts#A"
    const B = "ts:src/b.ts#B"
    const C = "ts:src/m.ts#Cx"
    const D = "ts:src/m.ts#Dx"
    const md = projectDiff(
      makeDiff({
        symbols: [
          changedSym(A, "A", "src/a.ts"),
          changedSym(B, "B", "src/b.ts"),
          changedSym(C, "Cx", "src/m.ts"),
          changedSym(D, "Dx", "src/m.ts"),
        ],
        slices: [slice(`slice:${A}`, [A, B]), slice(`slice:${C}`, [C, D])],
      }),
    )
    // Two multi-member slices → at least one thematic break between them.
    expect(md.split(/\n---\n/).length).toBeGreaterThanOrEqual(2)
    // And SV13: slices[] order preserved — slice:ts:src/a.ts#A must render
    // before slice:ts:src/m.ts#Cx.
    expect(md.indexOf(`slice:${A}`)).toBeLessThan(md.indexOf(`slice:${C}`))
  })

  it("§12.3 / SV20: singleton slices collapse into one <details> block after multi-member slices", () => {
    const ctlId = "ts:src/ctl.ts#Ctl.route"
    const svcId = "ts:src/svc.ts#Svc.op"
    const solo1 = "ts:src/util.ts#formatMoney"
    const solo2 = "ts:src/log.ts#log"
    const md = projectDiff(
      makeDiff({
        symbols: [
          changedSym(ctlId, "Ctl.route", "src/ctl.ts"),
          changedSym(svcId, "Svc.op", "src/svc.ts"),
          changedSym(solo1, "formatMoney", "src/util.ts"),
          changedSym(solo2, "log", "src/log.ts"),
        ],
        slices: [
          slice(`slice:${ctlId}`, [ctlId, svcId]),
          slice(`slice:${solo1}`, [solo1]),
          slice(`slice:${solo2}`, [solo2]),
        ],
      }),
    )
    // Multi-member slice comes first.
    const multiIdx = md.indexOf(`slice:${ctlId}`)
    const standaloneIdx = md.indexOf("### Standalone changes")
    expect(multiIdx).toBeGreaterThan(0)
    expect(standaloneIdx).toBeGreaterThan(multiIdx)
    // Details block declares the singleton count.
    expect(md).toContain("<details>")
    expect(md).toContain("<summary>2 singleton slices")
    // Both singleton ids appear inside the fold body.
    expect(md).toContain(`slice:${solo1}`)
    expect(md).toContain(`slice:${solo2}`)
  })

  it("§12.3: all-singleton case still emits Slice View section with just the Standalone fold", () => {
    const a = "ts:src/a.ts#a"
    const b = "ts:src/b.ts#b"
    const md = projectDiff(
      makeDiff({
        symbols: [changedSym(a, "a", "src/a.ts"), changedSym(b, "b", "src/b.ts")],
        slices: [slice(`slice:${a}`, [a]), slice(`slice:${b}`, [b])],
      }),
    )
    expect(md).toContain("🧵 Slice View")
    expect(md).toContain("### Standalone changes")
    expect(md).toContain("<summary>2 singleton slices")
    // No thematic break should appear when there are zero multi-member slices —
    // the fold body has none because singletons are one-line bullets.
  })

  it("§12.5: only-multi-member case emits no Standalone Changes heading", () => {
    const a = "ts:src/a.ts#a"
    const b = "ts:src/b.ts#b"
    const md = projectDiff(
      makeDiff({
        symbols: [changedSym(a, "a", "src/a.ts"), changedSym(b, "b", "src/b.ts")],
        slices: [slice(`slice:${a}`, [a, b])],
      }),
    )
    expect(md).toContain("🧵 Slice View")
    expect(md).not.toContain("Standalone changes")
  })
})

// call-resolution.md §8.1 + slice-view.md §5.4 — the drop stays silent in the
// data, but the projection tells the reviewer it happened.
describe("Slice View — unresolved-call markers (§12.6)", () => {
  const withUnresolved = (
    id: string,
    name: string,
    file: string,
    unresolved: number,
  ): SymbolChange => {
    const calls = Array.from({ length: unresolved }, (_, i) => ({
      target: `mystery${i}`,
      line: 20 + i,
      resolved: null,
    }))
    return {
      status: "changed",
      before: makeSymbol({ id, name, source: baseSource(file, 10), calls }),
      after: makeSymbol({ id, name, source: baseSource(file, 10), calls, fingerprint: fp(id) }),
      delta: {
        apiChanged: false,
        logicChanged: true,
        syntaxChanged: false,
        componentChanged: false,
        visibilityChanged: false,
      },
    }
  }

  it("notes the totals under the section heading when any member has unresolved calls", () => {
    const ctlId = "ts:src/ctl.ts#Ctl.route"
    const svcId = "ts:src/svc.ts#Svc.op"
    const md = projectDiff(
      makeDiff({
        symbols: [
          withUnresolved(ctlId, "Ctl.route", "src/ctl.ts", 3),
          changedSym(svcId, "Svc.op", "src/svc.ts"),
        ],
        slices: [slice(`slice:${ctlId}`, [ctlId, svcId])],
      }),
    )
    expect(md).toContain("1 of the changed symbols below makes 3 calls the resolver could not")
  })

  it("pluralizes the note when several members are affected", () => {
    const a = "ts:src/a.ts#a"
    const b = "ts:src/b.ts#b"
    const md = projectDiff(
      makeDiff({
        symbols: [withUnresolved(a, "a", "src/a.ts", 1), withUnresolved(b, "b", "src/b.ts", 2)],
        slices: [slice(`slice:${a}`, [a, b])],
      }),
    )
    expect(md).toContain("2 of the changed symbols below make 3 calls the resolver could not")
  })

  it("marks the affected member inside a multi-member slice", () => {
    const ctlId = "ts:src/ctl.ts#Ctl.route"
    const svcId = "ts:src/svc.ts#Svc.op"
    const md = projectDiff(
      makeDiff({
        symbols: [
          withUnresolved(ctlId, "Ctl.route", "src/ctl.ts", 3),
          changedSym(svcId, "Svc.op", "src/svc.ts"),
        ],
        slices: [slice(`slice:${ctlId}`, [ctlId, svcId])],
      }),
    )
    expect(md).toContain("⚠ 3 unresolved calls")
    expect(md).not.toContain("⚠ 0 unresolved")
  })

  it("marks an affected singleton — the case the reviewer actually needs", () => {
    const solo = "ts:src/ctl.ts#Ctl.route"
    const md = projectDiff(
      makeDiff({
        symbols: [withUnresolved(solo, "Ctl.route", "src/ctl.ts", 1)],
        slices: [slice(`slice:${solo}`, [solo])],
      }),
    )
    expect(md).toContain("### Standalone changes")
    expect(md).toContain("⚠ 1 unresolved call")
    expect(md).not.toContain("1 unresolved calls")
  })

  it("stays completely silent when every member resolved cleanly", () => {
    const a = "ts:src/a.ts#a"
    const b = "ts:src/b.ts#b"
    const md = projectDiff(
      makeDiff({
        symbols: [changedSym(a, "a", "src/a.ts"), changedSym(b, "b", "src/b.ts")],
        slices: [slice(`slice:${a}`, [a, b])],
      }),
    )
    expect(md).not.toContain("unresolved call")
    expect(md).not.toContain("⚠")
  })

  it("counts an added member's own calls", () => {
    const addedId = "ts:src/add.ts#addedFn"
    const md = projectDiff(
      makeDiff({
        symbols: [
          {
            status: "added",
            symbol: makeSymbol({
              id: addedId,
              name: "addedFn",
              source: baseSource("src/add.ts", 15),
              calls: [{ target: "mystery", line: 16, resolved: null }],
            }),
          },
        ],
        slices: [slice(`slice:${addedId}`, [addedId])],
      }),
    )
    expect(md).toContain("⚠ 1 unresolved call")
  })
})

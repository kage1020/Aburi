import { describe, expect, it } from "vitest"
import {
  projectComponent,
  projectDiff,
  projectDiffSummaryLine,
  projectSymbolExplain,
  projectWorkspace,
} from "../src"
import {
  call,
  component,
  decorator,
  dependency,
  effect,
  emptySummary,
  fp,
  makeDiff,
  makeIR,
  makeSymbol,
  rule,
  sig,
  zeroFp,
} from "./fixtures"

// -----------------------------------------------------------------------------
// MP1: same IR → same Markdown (determinism)
// -----------------------------------------------------------------------------

describe("MP1 — projection is deterministic", () => {
  it("workspace renders identical bytes for identical input", () => {
    const ir = makeIR({
      symbols: [makeSymbol({ id: "ts:src/a.ts#Foo", name: "Foo" })],
      components: [component({ id: "core", name: "core" })],
      dependencies: [dependency({ from: "core", to: "shared" })],
    })
    expect(projectWorkspace(ir)).toBe(projectWorkspace(ir))
  })

  it("component renders identical bytes for identical input", () => {
    const s = makeSymbol({
      id: "ts:src/a.ts#Foo",
      name: "Foo",
      component: "core",
    })
    const input = {
      component: component({ id: "core", name: "core" }),
      symbols: [s],
      dependencies: [],
    }
    expect(projectComponent(input)).toBe(projectComponent(input))
  })
})

// -----------------------------------------------------------------------------
// MP2: pre-shuffled arrays produce the same output (sort-neutrality)
// -----------------------------------------------------------------------------

describe("MP2 — component projection normalises input order", () => {
  it("emits identical Markdown when symbols come in reverse order", () => {
    const s1 = makeSymbol({
      id: "ts:src/a.ts#A",
      name: "A",
      source: { file: "src/a.ts", startLine: 3, endLine: 10, startColumn: null, endColumn: null },
    })
    const s2 = makeSymbol({
      id: "ts:src/a.ts#B",
      name: "B",
      source: { file: "src/a.ts", startLine: 5, endLine: 12, startColumn: null, endColumn: null },
    })
    const c = component({ id: "core", name: "core" })
    const forward = projectComponent({ component: c, symbols: [s1, s2], dependencies: [] })
    const reverse = projectComponent({ component: c, symbols: [s2, s1], dependencies: [] })
    expect(forward).toBe(reverse)
  })
})

// -----------------------------------------------------------------------------
// MP3: empty effects[] → Effects section omitted
// -----------------------------------------------------------------------------

describe("MP3 — Effects section is omitted when empty", () => {
  it("does not emit `**Effects**` for a Symbol with no effects", () => {
    const s = makeSymbol({ id: "ts:src/a.ts#Foo", name: "Foo" })
    const md = projectComponent({
      component: component({ id: "core", name: "core" }),
      symbols: [s],
      dependencies: [],
    })
    expect(md).not.toContain("**Effects**")
    expect(md).not.toContain("**Rules**")
    expect(md).not.toContain("**Calls**")
  })
})

// -----------------------------------------------------------------------------
// MP4: dropped Symbol → folded ## Dropped section
// -----------------------------------------------------------------------------

describe("MP4 — Dropped section is a <details> fold-out", () => {
  it("renders dropped symbols under a <details> block", () => {
    const dropped = makeSymbol({
      id: "ts:src/a.ts#Dto",
      name: "Dto",
      kind: "class",
      dropped: true,
      dropReason: "DTO shape",
      fingerprint: zeroFp(),
    })
    const md = projectComponent({
      component: component({ id: "core", name: "core" }),
      symbols: [dropped],
      dependencies: [],
    })
    expect(md).toContain("## Dropped")
    expect(md).toContain("<details>")
    expect(md).toContain("1 dropped symbols")
    expect(md).toContain("DTO shape")
  })
})

// -----------------------------------------------------------------------------
// MP5 / MP6: confidence badges
// -----------------------------------------------------------------------------

describe("MP5 / MP6 — confidence badge visibility", () => {
  it("MP5: medium confidence Effect gets ⚠ medium badge", () => {
    const s = makeSymbol({
      id: "ts:src/a.ts#Foo",
      name: "Foo",
      effects: [
        effect({
          id: "event.publish",
          target: "bus.emit",
          plugin: "effects-nest",
          confidence: "medium",
          derivedBy: "convention:test",
        }),
      ],
    })
    const md = projectComponent({
      component: component({ id: "core", name: "core" }),
      symbols: [s],
      dependencies: [],
    })
    expect(md).toContain("⚠ medium")
  })

  it("MP6: high confidence Effect has no badge", () => {
    const s = makeSymbol({
      id: "ts:src/a.ts#Foo",
      name: "Foo",
      effects: [
        effect({ id: "db.read", target: "prisma.user.findMany", plugin: "effects-prisma" }),
      ],
    })
    const md = projectComponent({
      component: component({ id: "core", name: "core" }),
      symbols: [s],
      dependencies: [],
    })
    expect(md).not.toContain("⚠")
  })
})

// -----------------------------------------------------------------------------
// MP7: mermaid fallback when node count exceeds limit
// -----------------------------------------------------------------------------

describe("MP7 — mermaid → text fallback beyond node limit", () => {
  it("skips the mermaid fence when node count > MERMAID_NODE_LIMIT", () => {
    const deps = Array.from({ length: 110 }, (_, i) => dependency({ from: `a${i}`, to: `b${i}` }))
    const ir = makeIR({ dependencies: deps })
    const md = projectWorkspace(ir)
    expect(md).not.toContain("```mermaid")
    // Text fallback is still there:
    expect(md).toContain("- a0 → b0")
  })

  it("includes mermaid fence when under the limit", () => {
    const ir = makeIR({
      dependencies: [dependency({ from: "core", to: "shared" })],
    })
    expect(projectWorkspace(ir)).toContain("```mermaid")
  })
})

// -----------------------------------------------------------------------------
// MP8: aburi explain on dropped Symbol
// -----------------------------------------------------------------------------

describe("MP8 — explain a dropped Symbol shows drop reason only", () => {
  it("emits drop reason and omits detail sections", () => {
    const s = makeSymbol({
      id: "ts:src/a.ts#Dto",
      name: "Dto",
      kind: "class",
      dropped: true,
      dropReason: "pure DTO",
      fingerprint: zeroFp(),
    })
    const md = projectSymbolExplain(s)
    expect(md).toContain("— dropped")
    expect(md).toContain("**Drop reason**: pure DTO")
    expect(md).not.toContain("## Rules")
    expect(md).not.toContain("## Effects")
    expect(md).not.toContain("## Calls")
    expect(md).not.toContain("## Fingerprint")
  })
})

// -----------------------------------------------------------------------------
// MP10: syntax-only change → Syntax-only fold-out
// -----------------------------------------------------------------------------

describe("MP10 — syntax-only changes end up in the Syntax-only fold-out", () => {
  it("routes delta.syntaxChanged (and only syntaxChanged) to the Syntax-only section", () => {
    const before = makeSymbol({ id: "ts:src/a.ts#Foo", name: "Foo", fingerprint: fp("v1") })
    const after = makeSymbol({
      ...before,
      fingerprint: { ...fp("v1"), syntax: "syn-refactor" },
    })
    const diff = makeDiff({
      summary: { ...emptySummary(), changed: 1 },
      symbols: [
        {
          status: "changed",
          before,
          after,
          delta: {
            apiChanged: false,
            logicChanged: false,
            syntaxChanged: true,
            componentChanged: false,
            visibilityChanged: false,
            rules: { added: [], removed: [], modified: [] },
            effects: { added: [], removed: [], modified: [] },
            calls: { added: [], removed: [], modified: [] },
            decorators: { added: [], removed: [], modified: [] },
            signature: null,
          },
        },
      ],
    })
    const md = projectDiff(diff)
    expect(md).toContain("## 🎨 Syntax-only changes")
    expect(md).not.toContain("## ⚠ API changes")
  })
})

// -----------------------------------------------------------------------------
// MP11: moved+changed → dedicated section, not folded
// -----------------------------------------------------------------------------

describe("MP11 — moved+changed renders outside the Moved fold-out", () => {
  it("emits a full detail block, not a bullet inside <details>", () => {
    const before = makeSymbol({
      id: "ts:src/old.ts#Foo",
      name: "Foo",
      fingerprint: fp("v1"),
    })
    const after = makeSymbol({
      id: "ts:src/new.ts#Foo",
      name: "Foo",
      fingerprint: { ...fp("v1"), logic: "logic-new" },
      source: { ...before.source, file: "src/new.ts" },
    })
    const diff = makeDiff({
      summary: { ...emptySummary(), movedChanged: 1 },
      symbols: [
        {
          status: "moved+changed",
          before,
          after,
          rationale: "git-rename",
          delta: {
            apiChanged: false,
            logicChanged: true,
            syntaxChanged: false,
            componentChanged: false,
            visibilityChanged: false,
            rules: { added: [], removed: [], modified: [] },
            effects: { added: [], removed: [], modified: [] },
            calls: { added: [], removed: [], modified: [] },
            decorators: { added: [], removed: [], modified: [] },
            signature: null,
          },
        },
      ],
    })
    const md = projectDiff(diff)
    expect(md).toContain("## 🔀 Moved + Changed")
    // Look for the block heading rather than the <details> fold-out.
    const movedSectionIdx = md.indexOf("## 🔀 Moved + Changed")
    const foldSectionIdx = md.indexOf("## 🔀 Moved\n")
    // Moved + Changed comes strictly before Moved when both exist; here the Moved-only
    // section is empty so it must be absent.
    expect(movedSectionIdx).toBeGreaterThan(-1)
    expect(foldSectionIdx).toBe(-1)
  })
})

// -----------------------------------------------------------------------------
// MP12: empty IR still produces a workspace.md
// -----------------------------------------------------------------------------

describe("MP12 — empty IR still projects workspace.md", () => {
  it("emits a Components section that acknowledges emptiness", () => {
    const ir = makeIR({ components: [], symbols: [] })
    const md = projectWorkspace(ir)
    expect(md).toContain("# Workspace")
    expect(md).toContain("_No components defined._")
  })
})

// -----------------------------------------------------------------------------
// Diff summary 1-line stdout
// -----------------------------------------------------------------------------

describe("projectDiffSummaryLine — CLI stdout summary", () => {
  it("emits `+A -R ~C ↔M ⤴MC` shape (§6.3)", () => {
    const diff = makeDiff({
      summary: {
        ...emptySummary(),
        added: 5,
        removed: 3,
        changed: 12,
        moved: 2,
        movedChanged: 1,
      },
    })
    expect(projectDiffSummaryLine(diff)).toBe("+5 -3 ~12 ↔2 ⤴1")
  })
})

// -----------------------------------------------------------------------------
// Section-omit — rules row rendering
// -----------------------------------------------------------------------------

describe("Rule row rendering (§5.6)", () => {
  it("renders guard with condition", () => {
    const s = makeSymbol({
      id: "ts:src/a.ts#Foo",
      name: "Foo",
      rules: [rule({ type: "guard", line: 5, condition: "x > 0" })],
    })
    const md = projectComponent({
      component: component({ id: "core", name: "core" }),
      symbols: [s],
      dependencies: [],
    })
    expect(md).toContain("- guard: `x > 0` (L5)")
  })

  it("renders loop with kind", () => {
    const s = makeSymbol({
      id: "ts:src/a.ts#Foo",
      name: "Foo",
      rules: [rule({ type: "loop", line: 10, loopKind: "for" })],
    })
    const md = projectComponent({
      component: component({ id: "core", name: "core" }),
      symbols: [s],
      dependencies: [],
    })
    expect(md).toContain("- loop (`for`) (L10)")
  })
})

// -----------------------------------------------------------------------------
// Fingerprint <sub> row is omitted for dropped
// -----------------------------------------------------------------------------

describe("Fingerprint row (§5.9)", () => {
  it("emits <sub> row for kept Symbol", () => {
    const s = makeSymbol({ id: "ts:src/a.ts#Foo", name: "Foo", fingerprint: fp("v1") })
    const md = projectComponent({
      component: component({ id: "core", name: "core" }),
      symbols: [s],
      dependencies: [],
    })
    expect(md).toContain("<sub>api=")
  })

  it("does NOT emit <sub> row for dropped Symbol (zero fingerprint)", () => {
    const s = makeSymbol({
      id: "ts:src/a.ts#Dto",
      name: "Dto",
      kind: "class",
      dropped: true,
      dropReason: "pure DTO",
      fingerprint: zeroFp(),
    })
    const md = projectComponent({
      component: component({ id: "core", name: "core" }),
      symbols: [s],
      dependencies: [],
    })
    expect(md).not.toContain("<sub>api=")
  })
})

// -----------------------------------------------------------------------------
// Explain: full detail with derivedBy list
// -----------------------------------------------------------------------------

describe("projectSymbolExplain kept-symbol layout", () => {
  it("emits Boundary, Signature, Rules, Effects, Calls, Derived by, Fingerprint sections", () => {
    const s = makeSymbol({
      id: "ts:src/a.ts#Foo.bar",
      name: "Foo.bar",
      kind: "method",
      component: "billing",
      signature: sig({ inputs: [{ name: "id", type: "string" }], outputs: ["Promise<User>"] }),
      decorators: [
        decorator({
          name: "Post",
          raw: "Post('/x')",
          arguments: ["'/x'"],
          boundary: true,
          line: 3,
        }),
      ],
      rules: [rule({ type: "throw", line: 8, what: "new E()" })],
      effects: [
        effect({
          id: "db.read",
          target: "prisma.user.findFirst",
          plugin: "effects-prisma",
          line: 6,
        }),
      ],
      calls: [call({ target: "helper.doWork", line: 7 })],
      derivedBy: ["framework:nestjs:controller", "effects-plugin:prisma:read"],
      fingerprint: fp("v1"),
    })
    const md = projectSymbolExplain(s)
    expect(md).toContain("## Boundary")
    expect(md).toContain("## Signature")
    expect(md).toContain("## Rules")
    expect(md).toContain("## Effects")
    expect(md).toContain("## Calls")
    expect(md).toContain("## Derived by")
    expect(md).toContain("## Fingerprint")
    expect(md).toContain("`framework:nestjs:controller`")
  })
})

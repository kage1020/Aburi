import type { ArrayDelta, SymbolChanged, SymbolDelta, SymbolMovedChanged } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src/diff"
import { emptySummary, makeDiff, makeSymbol } from "./fixtures"

/**
 * `ArrayDelta` has three buckets and `@aburi/diff` fills all three: `differentiate` puts
 * an element whose identity key matched but whose content changed into `modified`. For
 * `signature.inputs` the key is `${index}:${name}`, so a parameter whose *type* changed —
 * the most common breaking change in TypeScript — can only ever land there.
 *
 * A bucket the projection does not read produces a heading, a file link and no body: the
 * CI gate fires, and the Markdown that explains it to a reviewer is blank.
 *
 * `rules`, `effects`, `calls` and `signature.inputs` are the four the differ actually
 * fills. `signature.outputs` and `throws` go through `diffStringList` / `diffStringSet`,
 * which hardcode `modified: []`, so those are rendered for robustness against another
 * producer rather than to close a live gap.
 */

function emptyDelta(): ArrayDelta {
  return { added: [], removed: [], modified: [] }
}

function changed(delta: Partial<SymbolDelta>): SymbolChanged {
  const before = makeSymbol({ id: "ts:src/a.ts#f", name: "f" })
  const after = makeSymbol({ id: "ts:src/a.ts#f", name: "f" })
  return {
    status: "changed",
    before,
    after,
    delta: {
      apiChanged: false,
      logicChanged: true,
      syntaxChanged: false,
      componentChanged: false,
      visibilityChanged: false,
      ...delta,
    },
  }
}

function render(item: SymbolChanged): string {
  return projectDiff(makeDiff({ symbols: [item], summary: { ...emptySummary(), changed: 1 } }))
}

describe("rules / effects / calls — modified bucket", () => {
  it("renders a rewritten guard condition", () => {
    const md = render(
      changed({
        rules: {
          ...emptyDelta(),
          modified: [
            {
              type: "guard",
              line: 3,
              condition: "user.isAdmin && !user.banned",
              what: null,
              expr: null,
              loopKind: null,
            },
          ],
        },
      }),
    )

    expect(md).toContain("rules modified")
    expect(md).toContain("user.isAdmin && !user.banned")
  })

  it("renders an effect whose confidence was downgraded", () => {
    const md = render(
      changed({
        effects: {
          ...emptyDelta(),
          modified: [
            {
              id: "db.write",
              target: "prisma.user.create",
              line: 7,
              plugin: "effects-prisma",
              confidence: "low",
              derivedBy: "x",
            },
          ],
        },
      }),
    )

    expect(md).toContain("effects modified")
    expect(md).toContain("prisma.user.create")
  })

  it("renders a call that stopped resolving", () => {
    const md = render(
      changed({
        calls: { ...emptyDelta(), modified: [{ target: "useInvoices", line: 15, resolved: null }] },
      }),
    )

    expect(md).toContain("calls modified")
    expect(md).toContain("useInvoices")
  })
})

describe("signature — modified bucket", () => {
  const signature = (over: Partial<NonNullable<SymbolDelta["signature"]>>) => ({
    inputs: emptyDelta(),
    outputs: emptyDelta(),
    throws: emptyDelta(),
    asyncChanged: false,
    generatorChanged: false,
    typeParametersChanged: false,
    ...over,
  })

  it("names the parameter and its new type when an input type changes", () => {
    const md = render(
      changed({
        apiChanged: true,
        signature: signature({
          inputs: { ...emptyDelta(), modified: [{ name: "id", type: "number" }] },
        }),
      }),
    )

    expect(md).toContain("signature.inputs modified")
    // The type is the whole point: `getUser(id: string)` -> `getUser(id: number)` is a
    // breaking change that says nothing without it.
    expect(md).toContain("id: number")
  })

  // `outputs` and `throws` are diffed by `diffStringList` / `diffStringSet`, both of which
  // hardcode `modified: []`, so this pair is unreachable from `@aburi/diff` today. It is
  // rendered defensively — the projection reads a JSON document it did not produce — which
  // is why this case builds the delta by hand rather than through the differ.
  it("renders modified outputs and throws when a producer supplies them", () => {
    const md = render(
      changed({
        apiChanged: true,
        signature: signature({
          outputs: { ...emptyDelta(), modified: ["Promise<User>"] },
          throws: { ...emptyDelta(), modified: ["NotFoundError"] },
        }),
      }),
    )

    expect(md).toContain("Promise<User>")
    expect(md).toContain("NotFoundError")
  })
})

describe("empty-body note", () => {
  it("says so when a change carries no field-level detail", () => {
    // `apiChanged` / `logicChanged` come from fingerprint comparison, so this state is
    // reachable on a real document. Rendering a heading and nothing else reads as "no
    // reason found" — indistinguishable from a bucket the projection forgot to read.
    const md = render(changed({ logicChanged: true }))

    expect(md).toContain("logic fingerprint changed; no field-level detail was recorded")
  })

  it("names the API side when that is the flag that is set", () => {
    const md = render(changed({ apiChanged: true, logicChanged: false }))

    expect(md).toContain("API fingerprint changed")
  })

  it("adds no note when the delta rendered something", () => {
    const md = render(changed({ componentChanged: true }))

    expect(md).toContain("- component: changed")
    expect(md).not.toContain("no field-level detail")
  })

  it("prefers API when both the API and logic flags are set", () => {
    const md = render(changed({ apiChanged: true, logicChanged: true }))

    expect(md).toContain("API fingerprint changed")
    expect(md).not.toContain("logic fingerprint changed")
  })

  /**
   * `partition` routes every moved+changed entry into the Moved + Changed section whatever
   * its flags say, so `renderMovedChanged` reaches deltas the API and Logic sections never
   * see. A syntax-only move is the case least likely to carry field-level detail, and it
   * renders `**Delta**:` followed by nothing without this.
   */
  it("covers a syntax-only moved+changed, which no other section renders", () => {
    const before = makeSymbol({ id: "ts:src/a.ts#f", name: "f" })
    const after = makeSymbol({ id: "ts:src/b.ts#f", name: "f" })
    const moved: SymbolMovedChanged = {
      status: "moved+changed",
      before,
      after,
      rationale: "name-signature",
      delta: {
        apiChanged: false,
        logicChanged: false,
        syntaxChanged: true,
        componentChanged: false,
        visibilityChanged: false,
      },
    }

    const md = projectDiff(
      makeDiff({ symbols: [moved], summary: { ...emptySummary(), movedChanged: 1 } }),
    )

    expect(md).toContain("**Delta**:")
    expect(md).toContain("syntax fingerprint changed; no field-level detail was recorded")
  })
})

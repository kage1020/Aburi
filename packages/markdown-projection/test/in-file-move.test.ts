import { fp, makeSymbol, sliceId, symbolId } from "@aburi/test-support"
import type { Symbol as IRSymbol, SymbolChange, SymbolDelta } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src/diff"
import { emptySummary, makeDiff } from "./fixtures"

/** `makeSymbol` takes the file from the id; only the line is this suite's. */
function symbol(id: string, name: string, startLine: number, edited = false): IRSymbol {
  const base = makeSymbol({
    id,
    name,
    fingerprint: edited ? { ...fp("v1"), logic: fp("v2").logic } : fp("v1"),
  })
  return { ...base, source: { ...base.source, startLine, endLine: startLine + 5 } }
}

function delta(overrides: Partial<SymbolDelta> = {}): SymbolDelta {
  return {
    apiChanged: false,
    logicChanged: false,
    syntaxChanged: false,
    componentChanged: false,
    visibilityChanged: false,
    rules: { added: [], removed: [], modified: [] },
    effects: { added: [], removed: [], modified: [] },
    calls: { added: [], removed: [], modified: [] },
    decorators: { added: [], removed: [], modified: [] },
    signature: null,
    ...overrides,
  }
}

const renamedInFile: SymbolChange = {
  status: "moved",
  before: symbol("ts:src/output-file.ts#isADirectory", "isADirectory", 40),
  after: symbol("ts:src/output-file.ts#outputIsADirectory", "outputIsADirectory", 60),
  rationale: "logic-fingerprint",
}

const relocated: SymbolChange = {
  status: "moved",
  before: symbol("ts:src/util.ts#slug", "slug", 7),
  after: symbol("ts:src/text/slug.ts#slug", "slug", 1),
  rationale: "git-rename",
}

const reownedInFile: SymbolChange = {
  status: "moved+changed",
  before: symbol("ts:src/repo.ts#Repo.save", "Repo.save", 12),
  after: symbol("ts:src/repo.ts#UserRepo.save", "UserRepo.save", 30, true),
  rationale: "name-signature",
  delta: delta({ logicChanged: true }),
}

const acrossFiles: SymbolChange = {
  status: "moved+changed",
  before: symbol("ts:src/old.ts#Foo", "Foo", 5),
  after: symbol("ts:src/new.ts#Foo", "Foo", 5, true),
  rationale: "git-rename",
  delta: delta({ logicChanged: true }),
}

describe("a move within one file", () => {
  const md = projectDiff(
    makeDiff({
      summary: { ...emptySummary(), moved: 2, movedChanged: 2 },
      symbols: [renamedInFile, relocated, reownedInFile, acrossFiles],
    }),
  )

  it("names both sides and their lines, not the path twice, in Moved + Changed", () => {
    expect(md).toContain(
      "**Moved**: within `src/repo.ts`: `Repo.save` (L12) → `UserRepo.save` (L30) (`name-signature`)",
    )
    expect(md).not.toContain("`src/repo.ts` → `src/repo.ts`")
  })

  it("names both sides and their lines in the folded Moved list, and the head name once", () => {
    expect(md).toContain(
      "- within `src/output-file.ts`: `isADirectory` (L40) → `outputIsADirectory` (L60) " +
        "(`logic-fingerprint`)",
    )
  })

  it("keeps the two paths, and the leading name, for a move between files", () => {
    expect(md).toContain("**Moved**: `src/old.ts` → `src/new.ts` (`git-rename`)")
    expect(md).toContain("- `slug`: `src/util.ts` → `src/text/slug.ts` (`git-rename`)")
  })
})

describe("a Slice member's follow-up line", () => {
  const callerId = "ts:src/cli.ts#run"
  const caller: SymbolChange = {
    status: "changed",
    before: symbol(callerId, "run", 3),
    after: symbol(callerId, "run", 3, true),
    delta: delta({ logicChanged: true }),
  }

  function projectSlice(...moves: SymbolChange[]): string {
    const members = [callerId, ...moves.map(afterIdOf)].map(symbolId)
    return projectDiff(
      makeDiff({
        symbols: [...moves, caller],
        slices: [{ id: sliceId(`slice:${callerId}`), members }],
      }),
    )
  }

  it("leads a moved+changed member with its route, then its axes", () => {
    // The member a reviewer meets: `@aburi/diff` puts a moved+changed Symbol in the Node set.
    const md = projectSlice(reownedInFile, acrossFiles)
    expect(md).toContain(
      "↳ moved: within `src/repo.ts`: `Repo.save` (L12) → `UserRepo.save` (L30); delta.logicChanged",
    )
    expect(md).toContain("↳ moved: `src/old.ts` → `src/new.ts`; delta.logicChanged")
  })

  it("renders a pure moved member the same way, though `@aburi/diff` never lists one", () => {
    const md = projectSlice(renamedInFile, relocated)
    expect(md).toContain(
      "↳ moved: within `src/output-file.ts`: `isADirectory` (L40) → `outputIsADirectory` (L60)",
    )
    expect(md).toContain("↳ moved: `src/util.ts` → `src/text/slug.ts`")
  })
})

function afterIdOf(change: SymbolChange): string {
  if (change.status !== "moved" && change.status !== "moved+changed") {
    throw new Error(`not a move: ${change.status}`)
  }
  return change.after.id
}

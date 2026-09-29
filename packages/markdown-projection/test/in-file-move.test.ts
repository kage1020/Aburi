import { fp, makeSymbol, sliceId, symbolId } from "@aburi/test-support"
import type { Symbol as IRSymbol, SymbolChange } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src/diff"
import { emptySummary, makeDiff } from "./fixtures"

/** markdown-projection.md MP11a: a move within one file names the file once, with both names and lines. */

const at = (file: string, startLine: number) => ({
  file,
  startLine,
  endLine: startLine + 5,
  startColumn: null,
  endColumn: null,
})

const symbol = (id: string, name: string, startLine: number, logic = "same"): IRSymbol =>
  makeSymbol({
    id,
    name,
    source: at(id.slice(id.indexOf(":") + 1, id.indexOf("#")), startLine),
    fingerprint: { ...fp("v1"), logic },
  })

const emptyDelta = {
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
}

const renamedInFile: SymbolChange = {
  status: "moved",
  before: symbol("ts:src/output-file.ts#isADirectory", "isADirectory", 40),
  after: symbol("ts:src/output-file.ts#outputIsADirectory", "outputIsADirectory", 60),
  rationale: "logic-fingerprint",
}

const reownedInFile: SymbolChange = {
  status: "moved+changed",
  before: symbol("ts:src/repo.ts#Repo.save", "Repo.save", 12),
  after: symbol("ts:src/repo.ts#UserRepo.save", "UserRepo.save", 30, "edited"),
  rationale: "name-signature",
  delta: emptyDelta,
}

const acrossFiles: SymbolChange = {
  status: "moved+changed",
  before: symbol("ts:src/old.ts#Foo", "Foo", 5),
  after: symbol("ts:src/new.ts#Foo", "Foo", 5, "edited"),
  rationale: "git-rename",
  delta: emptyDelta,
}

describe("a move within one file", () => {
  const md = projectDiff(
    makeDiff({
      summary: { ...emptySummary(), moved: 1, movedChanged: 2 },
      symbols: [renamedInFile, reownedInFile, acrossFiles],
    }),
  )

  it("names both sides and their lines, not the path twice, in Moved + Changed", () => {
    expect(md).toContain(
      "**Moved**: within `src/repo.ts`: `Repo.save` (L12) → `UserRepo.save` (L30) (`name-signature`)",
    )
    expect(md).not.toContain("`src/repo.ts` → `src/repo.ts`")
  })

  it("names both sides and their lines in the folded Moved list", () => {
    expect(md).toContain(
      "- `outputIsADirectory`: within `src/output-file.ts`: `isADirectory` (L40) → " +
        "`outputIsADirectory` (L60) (`logic-fingerprint`)",
    )
  })

  it("keeps the two paths for a move between files", () => {
    expect(md).toContain("**Moved**: `src/old.ts` → `src/new.ts` (`git-rename`)")
  })

  it("names both sides and their lines on a Slice member's follow-up line", () => {
    const callerId = "ts:src/cli.ts#run"
    const caller: SymbolChange = {
      status: "changed",
      before: symbol(callerId, "run", 3),
      after: symbol(callerId, "run", 3, "edited"),
      delta: emptyDelta,
    }
    const members = [callerId, "ts:src/output-file.ts#outputIsADirectory"].map(symbolId)
    const sliced = projectDiff(
      makeDiff({
        symbols: [renamedInFile, caller],
        slices: [{ id: sliceId(`slice:${callerId}`), members }],
      }),
    )
    expect(sliced).toContain(
      "↳ moved: within `src/output-file.ts`: `isADirectory` (L40) → `outputIsADirectory` (L60)",
    )
  })
})

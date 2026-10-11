import { changed, makeDiff, makeSymbol, moved, movedChanged, sliceId } from "@aburi/test-support"
import type { Symbol as IRSymbol, SymbolChange } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectDiff } from "../src"
import { projectChanges } from "./fixtures"

function at(id: string, name: string, startLine: number): IRSymbol {
  const symbol = makeSymbol({ id, name })
  return { ...symbol, source: { ...symbol.source, startLine } }
}

const renamedInFile = moved(
  at("ts:src/output-file.ts#isADirectory", "isADirectory", 40),
  at("ts:src/output-file.ts#outputIsADirectory", "outputIsADirectory", 60),
  "logic-fingerprint",
)
const relocated = moved(
  at("ts:src/util.ts#slug", "slug", 7),
  at("ts:src/text/slug.ts#slug", "slug", 1),
)
const reownedInFile = movedChanged(
  at("ts:src/repo.ts#Repo.save", "Repo.save", 12),
  at("ts:src/repo.ts#UserRepo.save", "UserRepo.save", 30),
  { logicChanged: true },
  "name-signature",
)
const acrossFiles = movedChanged(
  at("ts:src/old.ts#Foo", "Foo", 5),
  at("ts:src/new.ts#Foo", "Foo", 5),
  {
    logicChanged: true,
  },
)
const renamedAcrossFiles = movedChanged(
  at("ts:src/parse.ts#parseAmount", "parseAmount", 1),
  at("ts:src/amount.ts#readAmount", "readAmount", 1),
  { apiChanged: true, syntaxChanged: true },
  "logic-fingerprint",
)
const relocatedAndRenamed = moved(
  at("ts:src/strings.ts#slugify", "slugify", 7),
  at("ts:src/text/slug.ts#toSlug", "toSlug", 1),
  "logic-fingerprint",
)

describe("a move's route in diff.md", () => {
  const md = projectChanges([
    renamedInFile,
    relocated,
    reownedInFile,
    acrossFiles,
    renamedAcrossFiles,
    relocatedAndRenamed,
  ])

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

  it("names each side with its file when a move between files renamed it too", () => {
    expect(md).toContain(
      "**Moved**: `parseAmount` in `src/parse.ts` → `readAmount` in `src/amount.ts` (`logic-fingerprint`)",
    )
    expect(md).toContain(
      "- `slugify` in `src/strings.ts` → `toSlug` in `src/text/slug.ts` (`logic-fingerprint`)",
    )
  })
})

describe("a move's route on a Slice member's follow-up line", () => {
  const caller = changed(at("ts:src/cli.ts#run", "run", 3), { logicChanged: true })

  function projectSlice(...moves: (SymbolChange & { after: IRSymbol })[]): string {
    return projectDiff(
      makeDiff({
        symbols: [...moves, caller],
        slices: [
          {
            id: sliceId("slice:ts:src/cli.ts#run"),
            members: [caller.after.id, ...moves.map((move) => move.after.id)],
          },
        ],
      }),
    )
  }

  it("leads a moved+changed member with its route, then its axes", () => {
    const md = projectSlice(reownedInFile, acrossFiles, renamedAcrossFiles)
    expect(md).toContain(
      "↳ moved: within `src/repo.ts`: `Repo.save` (L12) → `UserRepo.save` (L30); delta.logicChanged",
    )
    expect(md).toContain("↳ moved: `src/old.ts` → `src/new.ts`; delta.logicChanged")
    expect(md).toContain(
      "↳ moved: `parseAmount` in `src/parse.ts` → `readAmount` in `src/amount.ts`; " +
        "delta.apiChanged, delta.syntaxChanged",
    )
  })

  it("renders a pure moved member the same way, though `@aburi/diff` never lists one", () => {
    const md = projectSlice(renamedInFile, relocated, relocatedAndRenamed)
    expect(md).toContain(
      "↳ moved: within `src/output-file.ts`: `isADirectory` (L40) → `outputIsADirectory` (L60)",
    )
    expect(md).toContain("↳ moved: `src/util.ts` → `src/text/slug.ts`")
    expect(md).toContain("↳ moved: `slugify` in `src/strings.ts` → `toSlug` in `src/text/slug.ts`")
  })
})

import { dependency, fp, makeIR, makeSymbol } from "@aburi/test-support"
import type { Dependency, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { changeLines, diffOf } from "./helpers"

const call = (from: IRSymbol, to: IRSymbol, overrides: Partial<Dependency> = {}) =>
  dependency({ from: from.id, to: to.id, via: "call", ...overrides })

/** `name` declared in `file`, its fingerprints `seed`'s, so the same seed in two files is a move. */
const declared = (file: string, name: string, seed = name) =>
  makeSymbol({ id: `ts:${file}#${name}`, name, fingerprint: fp(seed) })

const caller = declared("src/middleware.ts", "analyzeUseArguments")
const callerMoved = declared("src/use.ts", "analyzeUseArguments")
const callee = declared("src/middleware.ts", "isPathLiteral")
const calleeMoved = declared("src/ast-helpers.ts", "isPathLiteral")
const calleeMovedAndChanged = makeSymbol({
  ...calleeMoved,
  id: calleeMoved.id,
  fingerprint: { ...fp("isPathLiteral"), syntax: "0123456789ab" },
})
const other = declared("src/ast-helpers.ts", "isIdentifier")

describe("a call edge whose endpoints only moved", () => {
  it.each([
    ["its callee", [caller, callee], [caller, calleeMoved], call(caller, calleeMoved)],
    ["its caller", [caller, callee], [callerMoved, callee], call(callerMoved, callee)],
    ["both ends", [caller, callee], [callerMoved, calleeMoved], call(callerMoved, calleeMoved)],
    [
      "a callee that moved and changed",
      [caller, callee],
      [caller, calleeMovedAndChanged],
      call(caller, calleeMovedAndChanged),
    ],
  ])("is no dependency change when %s moved", (_label, base, head, headEdge) => {
    const [from, to] = base as [IRSymbol, IRSymbol]
    const diff = diffOf(
      makeIR({ symbols: base, dependencies: [call(from, to)] }),
      makeIR({ symbols: head, dependencies: [headEdge] }),
    )

    expect(diff.summary).toMatchObject({ depsAdded: 0, depsRemoved: 0 })
    expect(diff.dependencies).toMatchObject({ added: [], removed: [] })
  })

  it("leaves the Symbol side reporting the move", () => {
    const diff = diffOf(
      makeIR({ symbols: [caller, callee], dependencies: [call(caller, callee)] }),
      makeIR({ symbols: [caller, calleeMoved], dependencies: [call(caller, calleeMoved)] }),
    )

    expect(changeLines(diff.symbols)).toEqual([`moved ${callee.id} -> ${calleeMoved.id}`])
  })
})

describe("a call edge whose endpoint moved and that also changed", () => {
  it("is removed, under the ids the base wrote, when the call went", () => {
    const diff = diffOf(
      makeIR({ symbols: [caller, callee], dependencies: [call(caller, callee)] }),
      makeIR({ symbols: [caller, calleeMoved] }),
    )

    expect(diff.dependencies).toMatchObject({ added: [], removed: [call(caller, callee)] })
  })

  it("is added beside the moved edge when the moved caller calls something new", () => {
    const diff = diffOf(
      makeIR({ symbols: [caller, callee, other], dependencies: [call(caller, callee)] }),
      makeIR({
        symbols: [callerMoved, callee, other],
        dependencies: [call(callerMoved, callee), call(callerMoved, other)],
      }),
    )

    expect(diff.dependencies).toMatchObject({ added: [call(callerMoved, other)], removed: [] })
  })

  it("is a removed and an added edge when its direction flipped", () => {
    const before = call(caller, callee)
    const after = call(caller, calleeMoved, { direction: "inbound" })
    const diff = diffOf(
      makeIR({ symbols: [caller, callee], dependencies: [before] }),
      makeIR({ symbols: [caller, calleeMoved], dependencies: [after] }),
    )

    expect(diff.dependencies).toMatchObject({ added: [after], removed: [before] })
  })
})

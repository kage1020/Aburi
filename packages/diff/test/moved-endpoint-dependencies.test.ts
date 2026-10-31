import { guardedBody, makeIR } from "@aburi/test-support"
import type { SkippedFile } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { callEdge, changeLines, diffOf, fn, withSkipped } from "./helpers"

const analyzeUseArguments = (file: string) => fn(file, "analyzeUseArguments", "analyzeUseArguments")
const isPathLiteral = (file: string, name = "isPathLiteral") =>
  fn(file, name, "isPathLiteral", { rules: guardedBody("ready") })

const caller = analyzeUseArguments("src/middleware.ts")
const callerMoved = analyzeUseArguments("src/use.ts")
const callee = isPathLiteral("src/middleware.ts")
const calleeMoved = isPathLiteral("src/ast-helpers.ts")
const calleeMovedAndChanged = {
  ...calleeMoved,
  fingerprint: { ...calleeMoved.fingerprint, syntax: "0123456789ab" },
}
const calleeRenamed = isPathLiteral("src/middleware.ts", "isLiteralPath")
const other = fn("src/ast-helpers.ts", "isIdentifier", "isIdentifier")

const NO_CHANGE = { added: [], removed: [], unknown: [] }

describe("a call edge whose endpoints were paired under new ids", () => {
  it.each([
    ["its callee moved", caller, calleeMoved, [`moved ${callee.id} -> ${calleeMoved.id}`]],
    ["its caller moved", callerMoved, callee, [`moved ${caller.id} -> ${callerMoved.id}`]],
    [
      "both ends moved",
      callerMoved,
      calleeMoved,
      [`moved ${callee.id} -> ${calleeMoved.id}`, `moved ${caller.id} -> ${callerMoved.id}`],
    ],
    [
      "its callee moved and changed",
      caller,
      calleeMovedAndChanged,
      [`moved+changed ${callee.id} -> ${calleeMoved.id}`],
    ],
    [
      "its callee was renamed in its file",
      caller,
      calleeRenamed,
      [`moved ${callee.id} -> ${calleeRenamed.id}`],
    ],
  ])("is no dependency change when %s", (_label, headCaller, headCallee, changes) => {
    const diff = diffOf(
      makeIR({ symbols: [caller, callee], dependencies: [callEdge(caller.id, callee.id)] }),
      makeIR({
        symbols: [headCaller, headCallee],
        dependencies: [callEdge(headCaller.id, headCallee.id)],
      }),
    )

    expect(changeLines(diff.symbols)).toEqual(changes)
    expect(diff.dependencies).toEqual(NO_CHANGE)
  })
})

describe("a call that changed while an endpoint moved", () => {
  it("is removed, under the ids the base wrote, when the call went", () => {
    const diff = diffOf(
      makeIR({ symbols: [caller, callee], dependencies: [callEdge(caller.id, callee.id)] }),
      makeIR({ symbols: [caller, calleeMoved] }),
    )

    expect(diff.dependencies).toEqual({
      ...NO_CHANGE,
      removed: [callEdge(caller.id, callee.id)],
    })
  })

  it("adds a moved caller's new call and leaves its unchanged one alone", () => {
    const diff = diffOf(
      makeIR({ symbols: [caller, callee, other], dependencies: [callEdge(caller.id, callee.id)] }),
      makeIR({
        symbols: [callerMoved, callee, other],
        dependencies: [callEdge(callerMoved.id, callee.id), callEdge(callerMoved.id, other.id)],
      }),
    )

    expect(diff.dependencies).toEqual({
      ...NO_CHANGE,
      added: [callEdge(callerMoved.id, other.id)],
    })
  })

  it("is a removed and an added edge when its direction flipped", () => {
    const before = callEdge(caller.id, callee.id)
    const after = callEdge(caller.id, calleeMoved.id, { direction: "inbound" })
    const diff = diffOf(
      makeIR({ symbols: [caller, callee], dependencies: [before] }),
      makeIR({ symbols: [caller, calleeMoved], dependencies: [after] }),
    )

    expect(diff.dependencies).toEqual({ ...NO_CHANGE, added: [after], removed: [before] })
  })
})

describe("a call edge whose callee moved out of a file the head skipped", () => {
  const lost: SkippedFile = { path: "src/middleware.ts", reason: "parse-failed" }

  it.each([
    [
      "is no dependency change when the head holds the call under the new id",
      [callEdge(callerMoved.id, calleeMoved.id)],
      NO_CHANGE,
    ],
    [
      "is unknown, under the ids the base wrote, when the head holds no call",
      [],
      {
        ...NO_CHANGE,
        unknown: [
          {
            dependency: callEdge(callerMoved.id, callee.id),
            absentFrom: "head",
            lostFiles: [lost],
          },
        ],
      },
    ],
  ])("%s", (_label, headDependencies, expected) => {
    const diff = diffOf(
      makeIR({
        symbols: [callerMoved, callee],
        dependencies: [callEdge(callerMoved.id, callee.id)],
      }),
      withSkipped(makeIR({ symbols: [callerMoved, calleeMoved], dependencies: headDependencies }), [
        lost,
      ]),
    )

    expect(diff.dependencies).toEqual(expected)
  })
})

describe("base edges that read as one under the head ids", () => {
  it("refuse the diff rather than drop one of them", () => {
    const undeclared = calleeMoved.id

    expect(() =>
      diffOf(
        makeIR({
          symbols: [callee, other],
          dependencies: [callEdge(callee.id, other.id), callEdge(undeclared, other.id)],
        }),
        makeIR({
          symbols: [calleeMoved, other],
          dependencies: [callEdge(calleeMoved.id, other.id)],
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "ir-identity-collision",
        value: `(${calleeMoved.id}, ${other.id}, call)`,
      }),
    )
  })
})

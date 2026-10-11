import { dependency, fp, makeIR, makeSymbol } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { writeCanonicalDiff } from "../src"
import { changeLines, diffOf, withSkipped } from "./helpers"

describe("symbols[]", () => {
  it("is ordered by status, then by the id of the Symbol each change is reported under", () => {
    const at = (file: string, name: string) =>
      makeSymbol({ id: `ts:${file}#${name}`, name, fingerprint: fp(name) })
    const diff = diffOf(
      makeIR({
        symbols: [at("src/gone.ts", "foo"), at("src/old.ts", "stale"), at("src/gone.ts", "bar")],
      }),
      withSkipped(makeIR({ symbols: [at("src/new.ts", "fresh"), at("src/a.ts", "Alpha")] }), [
        { path: "src/gone.ts", reason: "parse-failed" },
      ]),
    )
    expect(changeLines(diff.symbols)).toEqual([
      "added ts:src/a.ts#Alpha",
      "added ts:src/new.ts#fresh",
      "removed ts:src/old.ts#stale",
      "unknown ts:src/gone.ts#bar",
      "unknown ts:src/gone.ts#foo",
    ])
  })
})

describe("writeCanonicalDiff", () => {
  it("writes unknown edges byte-identically however the inputs are ordered", () => {
    const gone = makeSymbol({ id: "ts:src/gone.ts#gone", name: "gone" })
    const also = makeSymbol({ id: "ts:src/also.ts#also", name: "also" })
    const kept = makeSymbol({ id: "ts:src/kept.ts#kept", name: "kept" })
    const edges = [
      dependency({ from: kept.id, to: gone.id, via: "call" }),
      dependency({ from: also.id, to: kept.id, via: "call" }),
    ]
    const head = withSkipped(makeIR({ symbols: [kept] }), [
      { path: "src/also.ts", reason: "parse-failed" },
      { path: "src/gone.ts", reason: "parse-failed" },
    ])
    const forward = diffOf(makeIR({ symbols: [gone, also, kept], dependencies: edges }), head)
    const reversed = diffOf(
      makeIR({ symbols: [kept, also, gone], dependencies: [...edges].reverse() }),
      head,
    )
    expect(forward.dependencies.unknown).toHaveLength(2)
    expect(writeCanonicalDiff(forward)).toBe(writeCanonicalDiff(reversed))
  })

  it("writes an empty notCompared array rather than dropping the key", () => {
    const kept = makeSymbol({ id: "ts:src/kept.ts#kept", name: "kept" })
    const ir = makeIR({ symbols: [kept] })
    expect(writeCanonicalDiff(diffOf(ir, ir))).toContain('"notCompared": []')
  })
})

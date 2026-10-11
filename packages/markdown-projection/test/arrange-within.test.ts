import { describe, expect, it } from "vitest"
import { type Arrangement, arrangeWithin, type Section } from "../src/diff/size-cap"

describe("arrangeWithin — checked against every arrangement of small inputs", () => {
  function section(title: string, full: number, short: number | null): Section {
    const lines = (count: number) => Array.from({ length: count }, () => title)
    return { title, lines: lines(full), ...(short === null ? {} : { short: lines(short) }) }
  }

  function size(arrangement: Arrangement): number {
    let total = 0
    for (const { section, shown } of arrangement) {
      if (shown.kind === "full") total += section.lines.length
      if (shown.kind === "short") total += shown.lines.length
    }
    return total
  }

  function* every(sections: readonly Section[]): Generator<Arrangement> {
    const [first, ...rest] = sections
    if (first === undefined) {
      yield []
      return
    }
    const forms: Arrangement[number]["shown"][] = [{ kind: "full" }, { kind: "omitted" }]
    if (first.short !== undefined) forms.push({ kind: "short", lines: first.short })
    for (const tail of every(rest)) {
      for (const shown of forms) yield [{ section: first, shown }, ...tail]
    }
  }

  /** Which sections are kept, most important first: the thing ranked first. */
  const kept = (arrangement: Arrangement) =>
    arrangement.map(({ shown }) => shown.kind !== "omitted")
  /** The lists shown whole before the first shown short, or `null` when that is not a run. */
  function wholeRun(arrangement: Arrangement): number | null {
    const lists = arrangement.filter(
      ({ section, shown }) => section.short !== undefined && shown.kind !== "omitted",
    )
    const run = lists.findIndex(({ shown }) => shown.kind === "short")
    const length = run < 0 ? lists.length : run
    return lists.slice(length).every(({ shown }) => shown.kind === "short") ? length : null
  }
  function ranksAbove(a: Arrangement, b: Arrangement): boolean {
    const [keptA, keptB] = [kept(a), kept(b)]
    const differ = keptA.findIndex((value, index) => value !== keptB[index])
    if (differ >= 0) return keptA[differ] === true
    return (wholeRun(a) ?? -1) > (wholeRun(b) ?? -1)
  }

  it("keeps the most important sections it can, then shows whole the longest top run", () => {
    let seed = 20260924
    const random = () => {
      seed = (seed * 48271) % 2147483647
      return seed / 2147483647
    }
    for (let trial = 0; trial < 400; trial++) {
      const sections = Array.from({ length: 5 }, (_, index) => {
        const full = 1 + Math.floor(random() * 20)
        const short = full > 1 && random() < 0.6 ? 1 + Math.floor(random() * (full - 1)) : null
        return section(`s${index}`, full, short)
      })
      const budget = Math.floor(random() * sections.reduce((sum, s) => sum + s.lines.length, 0))
      const fits = (arrangement: Arrangement) => size(arrangement) <= budget

      let best: Arrangement | null = null
      for (const arrangement of every(sections)) {
        if (!fits(arrangement) || wholeRun(arrangement) === null) continue
        if (best === null || ranksAbove(arrangement, best)) best = arrangement
      }
      const kinds = (arrangement: Arrangement | null) =>
        arrangement?.map(({ shown }) => shown.kind) ?? null
      expect(kinds(arrangeWithin(sections, fits))).toEqual(kinds(best))
    }
  })
})

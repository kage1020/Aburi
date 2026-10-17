import { describe, expect, it } from "vitest"
import { type Arrangement, arrangeWithin, type Section, type Shown } from "../src/diff/size-cap"

type Measure = (arrangement: Arrangement) => number

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

/** `size` plus a note: a claim per kind named in it, and `title` lines per section named. */
function notedWith(title: number): Measure {
  return (arrangement) => {
    const count = (kind: string) => arrangement.filter(({ shown }) => shown.kind === kind).length
    const named = (sections: number) => (sections > 0 ? 4 + title * sections : 0)
    return size(arrangement) + named(count("short")) + named(count("omitted"))
  }
}
const noted = notedWith(1)

const kinds = (arrangement: Arrangement | null) =>
  arrangement?.map(({ shown }) => shown.kind) ?? null

const OMITTED: Shown = { kind: "omitted" }

function shownForms(section: Section): Shown[] {
  const forms: Shown[] = [{ kind: "full" }]
  if (section.short !== undefined) forms.push({ kind: "short", lines: section.short })
  return forms
}

function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 48271) % 2147483647
    return state / 2147483647
  }
}

function randomSections(random: () => number, longest: number): Section[] {
  return Array.from({ length: 5 }, (_, index) => {
    const full = 1 + Math.floor(random() * longest)
    const short = full > 1 && random() < 0.6 ? 1 + Math.floor(random() * (full - 1)) : null
    return section(`s${index}`, full, short)
  })
}

const totalLines = (sections: readonly Section[]) =>
  sections.reduce((sum, { lines }) => sum + lines.length, 0)

describe("arrangeWithin — checked against every arrangement of small inputs", () => {
  function* every(sections: readonly Section[]): Generator<Arrangement> {
    const [first, ...rest] = sections
    if (first === undefined) {
      yield []
      return
    }
    for (const tail of every(rest)) {
      for (const shown of [...shownForms(first), OMITTED]) {
        yield [{ section: first, shown }, ...tail]
      }
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
    const random = seeded(20260924)
    for (let trial = 0; trial < 400; trial++) {
      const sections = randomSections(random, 20)
      const budget = Math.floor(random() * totalLines(sections))

      let best: Arrangement | null = null
      for (const arrangement of every(sections)) {
        if (size(arrangement) > budget || wholeRun(arrangement) === null) continue
        if (best === null || ranksAbove(arrangement, best)) best = arrangement
      }
      expect(kinds(arrangeWithin(sections, size, budget))).toEqual(kinds(best))
    }
  })
})

describe("arrangeWithin — with a note that names sections", () => {
  const replaced = (arrangement: Arrangement, index: number, shown: Shown): Arrangement =>
    arrangement.map((row, at) => (at === index ? { section: row.section, shown } : row))

  /** The first list shown whole below a names-only one although names-only is smaller. */
  function firstOutOfOrder(arrangement: Arrangement, measure: Measure) {
    const bytes = measure(arrangement)
    let shortAbove = false
    for (const [index, { section, shown }] of arrangement.entries()) {
      if (section.short === undefined) continue
      if (shown.kind === "short") shortAbove = true
      if (shown.kind !== "full" || !shortAbove) continue
      const shorter = replaced(arrangement, index, { kind: "short", lines: section.short })
      if (measure(shorter) < bytes) return { index, shorter }
    }
    return null
  }

  /** Null where the order breaks at or above `index`, which no list below can mend. */
  function inOrderBelow(arrangement: Arrangement, index: number, measure: Measure) {
    let current = arrangement
    let next = firstOutOfOrder(current, measure)
    while (next !== null) {
      if (next.index <= index) return null
      current = next.shorter
      next = firstOutOfOrder(current, measure)
    }
    return current
  }

  it.each<[string, Section[], Measure, number, Shown["kind"][]]>([
    [
      "keeps a list whole below a names-only one where names-only does not fit",
      [section("s0", 30, 5), section("s1", 10, 9)],
      notedWith(3),
      22,
      ["short", "full"],
    ],
    [
      "keeps a list whole below a names-only one where whole is the smaller document",
      [section("s0", 30, 5), section("s1", 10, 9)],
      notedWith(3),
      24,
      ["short", "full"],
    ],
    [
      "keeps a list whole on a tie with its names-only form",
      [section("s0", 30, 5), section("s1", 3, 2)],
      noted,
      15,
      ["short", "full"],
    ],
    [
      "keeps a list whole on a tie below a section put back as names-only",
      [section("s0", 30, 5), section("s1", 3, 2)],
      noted,
      13,
      ["short", "full"],
    ],
    [
      "puts the most important omitted section back first once the note has room",
      [section("s0", 8, 4), section("s1", 8, null), section("s2", 8, null), section("s3", 1, null)],
      notedWith(2),
      23,
      ["full", "full", "omitted", "full"],
    ],
    [
      "makes a list below names-only rather than leave out a more important section",
      [section("s0", 20, 10), section("s1", 3, 1)],
      noted,
      18,
      ["short", "short"],
    ],
    [
      "counts the room a list below frees by going names-only",
      [section("s0", 20, 10), section("s1", 3, 1)],
      noted,
      17,
      ["short", "short"],
    ],
  ])("%s", (_, sections, measure, budget, expected) => {
    expect(kinds(arrangeWithin(sections, measure, budget))).toEqual(expected)
  })

  it("leaves no omitted section that fits back in, when the note's cost makes sizes interact", () => {
    // The passes are greedy, so this pins what they promise rather than the best arrangement.
    const random = seeded(20261002)
    for (let trial = 0; trial < 2000; trial++) {
      const measure = notedWith(trial % 2 === 0 ? 1 : 3)
      const sections = randomSections(random, 12)
      const budget = Math.floor(random() * (totalLines(sections) + 20))
      const got = arrangeWithin(sections, measure, budget)
      const everyOmitted = got.map(({ section }) => ({ section, shown: OMITTED }))
      if (measure(everyOmitted) > budget) continue

      expect(measure(got)).toBeLessThanOrEqual(budget)
      expect(firstOutOfOrder(got, measure)).toBeNull()
      for (const [index, { section, shown }] of got.entries()) {
        if (shown.kind !== "omitted") continue
        for (const form of shownForms(section)) {
          const candidate = inOrderBelow(replaced(got, index, form), index, measure)
          if (candidate === null) continue
          expect(measure(candidate), `s${index} as ${form.kind}`).toBeGreaterThan(budget)
        }
      }
      const firstShort = got.findIndex(({ shown }) => shown.kind === "short")
      if (firstShort >= 0) {
        const whole = replaced(got, firstShort, { kind: "full" })
        if (firstOutOfOrder(whole, measure) === null) {
          expect(measure(whole)).toBeGreaterThan(budget)
        }
      }
    }
  })
})

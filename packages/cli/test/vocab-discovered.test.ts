import type { UndeclaredVocabOccurrence } from "@aburi/core"
import { describe, expect, it } from "vitest"
import { summarizeUndeclaredVocab } from "../src/vocab-discovered"

/** `extension-vocab.md` §11.5.1: one item per (kind, value), first emitter first. */

function occurrence(
  plugin: string,
  file: string,
  extra: Partial<UndeclaredVocabOccurrence> = {},
): UndeclaredVocabOccurrence {
  return {
    kind: "effect",
    value: "x-acme:ping",
    plugin,
    file,
    line: 4,
    symbol: `stub:${file}#f`,
    ...extra,
  }
}

describe("summarizeUndeclaredVocab", () => {
  it("credits the first emitter and lists the others once each, in the order they first emitted", () => {
    const [item] = summarizeUndeclaredVocab([
      occurrence("effects-b", "a.stub"),
      occurrence("effects-c", "b.stub"),
      occurrence("effects-b", "c.stub"),
      occurrence("effects-a", "d.stub"),
      occurrence("effects-c", "e.stub"),
    ])
    expect(item).toMatchObject({
      firstSeenBy: "effects-b",
      alsoSeenBy: ["effects-c", "effects-a"],
      occurrences: 5,
    })
  })

  it("quotes the first three occurrences and keeps counting past them", () => {
    const [item] = summarizeUndeclaredVocab(
      ["a", "b", "c", "d", "e"].map((name) => occurrence("effects-a", `${name}.stub`)),
    )
    expect(item?.occurrences).toBe(5)
    expect(item?.samples.map((sample) => sample.file)).toEqual(["a.stub", "b.stub", "c.stub"])
  })

  it("keeps an effect and an extKind apart when they share a value, and leaves out a missing line", () => {
    const items = summarizeUndeclaredVocab([
      occurrence("effects-a", "a.stub"),
      occurrence("lang-stub", "a.stub", { kind: "extKind", line: null }),
    ])
    expect(items.map((item) => [item.kind, item.firstSeenBy])).toEqual([
      ["effect", "effects-a"],
      ["extKind", "lang-stub"],
    ])
    expect(items[1]?.samples).toEqual([{ file: "a.stub", symbol: "stub:a.stub#f" }])
  })
})

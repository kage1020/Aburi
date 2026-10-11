import { component, fp, guardedBody, makeIR, makeSymbol, rule, zeroFp } from "@aburi/test-support"
import type { Fingerprint, Symbol as IRSymbol, MatchRationale } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDiff, classifyStatus, dropDirection } from "../src"
import { changeLines, diffOf, diffSymbols, dropped, soleChange } from "./helpers"

describe("a Symbol only one side holds", () => {
  const foo = makeSymbol({ id: "ts:src/a.ts#Foo", name: "Foo" })

  it("is added when only head holds it", () => {
    const diff = diffSymbols([], [foo])
    expect(changeLines(diff.symbols)).toEqual(["added ts:src/a.ts#Foo"])
    expect(diff.summary.added).toBe(1)
  })

  it("is removed when only base holds it", () => {
    const diff = diffSymbols([foo], [])
    expect(changeLines(diff.symbols)).toEqual(["removed ts:src/a.ts#Foo"])
    expect(diff.summary.removed).toBe(1)
  })
})

describe("a Document diffed against itself", () => {
  it("reports no change and counts every Symbol unchanged", () => {
    const ir = makeIR({
      symbols: [
        makeSymbol({ id: "ts:src/a.ts#Foo", name: "Foo" }),
        makeSymbol({ id: "ts:src/b.ts#Bar", name: "Bar" }),
      ],
      components: [component({ id: "billing", name: "billing" })],
    })
    const diff = diffOf(ir, ir)
    expect(diff.symbols).toEqual([])
    expect(diff.summary.unchanged).toBe(2)
    expect(diff.components).toEqual({ added: [], removed: [], changed: [] })
    expect(diff.dependencies).toEqual({ added: [], removed: [], unknown: [] })
  })
})

describe("a pair whose fingerprint moved", () => {
  it.each<keyof Fingerprint>([
    "api",
    "logic",
    "syntax",
  ])("is changed, with only the %s axis set on the delta", (axis) => {
    const base = makeSymbol({ id: "ts:src/a.ts#Foo", name: "Foo", fingerprint: fp("v1") })
    const head = makeSymbol({ ...base, fingerprint: { ...fp("v1"), [axis]: "moved0000000" } })
    expect(soleChange(diffSymbols([base], [head]).symbols, "changed").delta).toMatchObject({
      apiChanged: false,
      logicChanged: false,
      syntaxChanged: false,
      [`${axis}Changed`]: true,
    })
  })
})

describe("a pair matched under a different id", () => {
  const atOld = makeSymbol({
    id: "ts:src/old.ts#Foo",
    name: "Foo",
    fingerprint: fp("v1"),
    rules: guardedBody("ready"),
  })
  const atNew = makeSymbol({
    ...atOld,
    id: "ts:src/new.ts#Foo",
    source: { ...atOld.source, file: "src/new.ts" },
  })
  const renamedInPlace = (name: string) =>
    makeSymbol({
      id: `ts:src/a.ts#Cls.${name}`,
      name: `Cls.${name}`,
      kind: "method",
      fingerprint: fp("v1"),
      rules: guardedBody("id"),
    })

  it.each<[string, IRSymbol, IRSymbol, Map<string, string> | null, MatchRationale]>([
    ["git renamed its file", atOld, atNew, new Map([["src/old.ts", "src/new.ts"]]), "git-rename"],
    ["its file moved with the body intact", atOld, atNew, null, "logic-fingerprint"],
    [
      "it was renamed in its own file",
      renamedInPlace("getUser"),
      renamedInPlace("fetchUser"),
      null,
      "logic-fingerprint",
    ],
    [
      "a dropped Symbol's directory moved",
      dropped("src/old/dto.ts", "Dto"),
      dropped("src/new/dto.ts", "Dto"),
      null,
      "dropped-weak-match",
    ],
  ])("is moved when %s, with the stage that paired it as rationale", (_, base, head, gitRenames, rationale) => {
    const diff = diffSymbols([base], [head], { gitRenames })
    expect(soleChange(diff.symbols, "moved").rationale).toBe(rationale)
    expect(diff.summary.moved).toBe(1)
  })

  it("is moved+changed, with rationale and delta, when its content changed too", () => {
    const head = makeSymbol({
      ...atNew,
      fingerprint: { ...fp("v1"), logic: "logic0000new" },
      rules: [...atOld.rules, rule({ type: "guard", line: 8, condition: "x != null" })],
    })
    const diff = diffSymbols([atOld], [head], {
      gitRenames: new Map([["src/old.ts", "src/new.ts"]]),
    })
    const change = soleChange(diff.symbols, "moved+changed")
    expect(change.rationale).toBe("git-rename")
    expect(change.delta.logicChanged).toBe(true)
    expect(change.delta.rules?.added).toHaveLength(1)
    expect(diff.summary.movedChanged).toBe(1)
  })
})

describe("a Symbol whose component moved under it", () => {
  it("is unchanged: redrawing a boundary is not editing the code", () => {
    const inApi = makeSymbol({ id: "ts:packages/api/a.ts#f", name: "f", component: "api" })
    expect(classifyStatus(inApi, makeSymbol({ ...inApi, component: "shared" }))).toBe("unchanged")
  })
})

describe("a Symbol whose confidence moved under it", () => {
  const sure = makeSymbol({ id: "ts:src/a.ts#C", name: "C", kind: "class", confidence: "high" })
  const unsure = makeSymbol({ ...sure, confidence: "medium" })

  it("is changed although no fingerprint moved, in either direction", () => {
    expect(classifyStatus(sure, unsure)).toBe("changed")
    expect(classifyStatus(unsure, sure)).toBe("changed")
  })

  it("is moved+changed when the Symbol also moved file", () => {
    const moved = makeSymbol({
      ...unsure,
      id: "ts:src/b.ts#C",
      source: { ...unsure.source, file: "src/b.ts" },
    })
    expect(classifyStatus(sure, moved)).toBe("moved+changed")
  })

  it("is reported through buildDiff with only the confidence axis set", () => {
    const diff = diffSymbols([sure], [unsure])
    expect(soleChange(diff.symbols, "changed").delta).toMatchObject({
      apiChanged: false,
      logicChanged: false,
      syntaxChanged: false,
      confidenceChanged: true,
    })
    expect(diff.summary.changed).toBe(1)
  })
})

describe("a pair dropped on both sides", () => {
  it("stays unchanged, even when its confidence moved", () => {
    const base = makeSymbol({
      id: "ts:src/a.ts#Dto",
      name: "Dto",
      kind: "class",
      dropped: true,
      dropReason: "DTO",
      fingerprint: zeroFp(),
      confidence: "high",
    })
    const diff = diffSymbols([base], [{ ...base, confidence: "low" }])
    expect(diff.symbols).toEqual([])
    expect(diff.summary).toMatchObject({ unchanged: 1, droppedAdded: 0, droppedRemoved: 0 })
  })
})

describe("a pair whose dropped flag flipped", () => {
  const kept = makeSymbol({
    id: "ts:src/a.ts#Dto",
    name: "Dto",
    kind: "class",
    fingerprint: fp("v1"),
  })
  const droppedDto = makeSymbol({
    ...kept,
    dropped: true,
    dropReason: "DTO",
    fingerprint: zeroFp(),
  })

  it.each([
    ["to-dropped", kept, droppedDto],
    ["to-kept", droppedDto, kept],
  ] as const)("is dropped-toggled %s, whatever its fingerprint did", (direction, base, head) => {
    expect(classifyStatus(base, head)).toBe("dropped-toggled")
    expect(dropDirection(head)).toBe(direction)
  })

  it("is counted as dropped-toggled rather than changed, and carries no delta", () => {
    const before = ["A", "B"].map((name) =>
      makeSymbol({ id: `ts:src/a.ts#${name}`, name, kind: "class" }),
    )
    const after = before.map((symbol) => ({ ...symbol, dropped: true, fingerprint: zeroFp() }))
    const diff = diffSymbols(before, after)
    expect(diff.summary).toMatchObject({ droppedToggled: 2, changed: 0, moved: 0 })
    expect(diff.symbols.map((change) => change.status)).toEqual([
      "dropped-toggled",
      "dropped-toggled",
    ])
    for (const change of diff.symbols) expect(change).not.toHaveProperty("delta")
  })
})

describe("the summary counts Components by status", () => {
  it("counts an added, a removed and a changed Component", () => {
    const diff = diffOf(
      makeIR({
        components: [
          component({ id: "billing", name: "Billing" }),
          component({ id: "legacy", name: "legacy" }),
        ],
      }),
      makeIR({
        components: [
          component({ id: "billing", name: "Billing & Invoicing" }),
          component({ id: "payments", name: "payments" }),
        ],
      }),
    )
    expect(diff.summary).toMatchObject({
      componentsAdded: 1,
      componentsRemoved: 1,
      componentsChanged: 1,
    })
  })
})

describe("the envelope around the changes", () => {
  const ir = makeIR()

  it("names the diff schema and carries both refs through", () => {
    const base = { ref: "main", irSchema: ir.$schema }
    const head = { ref: "feature", irSchema: ir.$schema }
    const diff = buildDiff({ baseIR: ir, headIR: ir, base, head })
    expect(diff.$schema).toBe("https://aburi.kage1020.com/schema/aburi.diff.v1.json")
    expect(diff.base).toEqual(base)
    expect(diff.head).toEqual(head)
  })

  it("writes the default generator record when none is given", () => {
    expect(diffOf(ir, ir).generator).toEqual({ name: "aburi", version: "0.0.0" })
  })

  it("writes the generator record it is given", () => {
    const generator = { name: "aburi-cli", version: "1.2.3" }
    expect(diffOf(ir, ir, { generator }).generator).toEqual(generator)
  })
})

import { describe, expect, it } from "vitest"
import { hintOf, idsOf, symbolOf, walkOf } from "./fixtures/ctx"

const PAIR = "export class Box { get value() { return read() } set value(n) { write(n) } }"

describe("a getter and a setter declare one member", () => {
  it("emits one Symbol for the pair, marked as an accessor two declarations made", async () => {
    const symbol = await symbolOf(PAIR, "ts:src/a.ts#Box.value")

    expect(await idsOf(PAIR)).toEqual(["ts:src/a.ts#Box", "ts:src/a.ts#Box.value"])
    expect(symbol.derivedBy).toEqual(["class-method", "accessor-declaration", "declaration-merged"])
  })

  it("takes the signature and the range from the getter, even when the setter is written first", async () => {
    const source = [
      "export class Box {",
      "  set value(n) { write(n) }",
      "  get value() { return read() }",
      "}",
    ].join("\n")
    const symbol = await symbolOf(source, "ts:src/a.ts#Box.value")

    expect(symbol.signature?.inputs).toEqual([])
    expect(symbol.source.startLine).toBe(3)
    expect((await walkOf(source, "ts:src/a.ts#Box.value")).calls.map((c) => c.target)).toEqual([
      "write",
      "read",
    ])
  })

  it.each([
    ["a getter alone", "export class G { get v() { return 1 } }"],
    ["a setter alone", "export class G { set v(n) {} }"],
  ])("emits one Symbol for %s, with nothing merged into it", async (_label, source) => {
    const symbol = await symbolOf(source, "ts:src/a.ts#G.v")

    expect(symbol.derivedBy).toEqual(["class-method", "accessor-declaration"])
    expect("mergedDeclarations" in symbol).toBe(false)
  })

  it("does not call a plain method an accessor", async () => {
    const symbol = await symbolOf("export class A { m() {} }", "ts:src/a.ts#A.m")

    expect(symbol.derivedBy).toEqual(["class-method"])
  })

  it("keeps a static pair apart from an instance pair of the same name", async () => {
    const source = [
      "export class S {",
      "  get v() { return 1 }",
      "  set v(n) {}",
      "  static get v() { return 2 }",
      "  static set v(n) {}",
      "}",
    ].join("\n")

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#S", "ts:src/a.ts#S.v", "ts:src/a.ts#S::v"])
  })

  it("keeps a private-name pair private", async () => {
    const source = "export class P { get #v() { return 1 } set #v(n) {} }"

    expect((await symbolOf(source, "ts:src/a.ts#P.#v")).visibility).toBe("private")
  })

  it.each([
    [
      "the setter leads",
      ["export class A {", "  @Validate() set v(n) {}", "  @Memo() get v() { return 1 }", "}"],
      ["Validate", "Memo"],
    ],
    [
      "the getter leads",
      ["export class A {", "  @Memo() get v() { return 1 }", "  @Validate() set v(n) {}", "}"],
      ["Memo", "Validate"],
    ],
  ])("joins both declarations' decorators in source order where %s", async (_label, lines, names) => {
    const symbol = await symbolOf(lines.join("\n"), "ts:src/a.ts#A.v")

    expect(symbol.decorators.map((d) => d.name)).toEqual(names)
  })

  it("still says nothing about a computed accessor", async () => {
    expect(await idsOf("export class C { get [k]() { return 1 } set [k](n) {} }")).toEqual([
      "ts:src/a.ts#C",
    ])
  })

  it("does not call a pair empty-bodied when only the getter is empty", async () => {
    const source = "export class A { get v() {} set v(n) { audit(n) } }"

    expect(await hintOf(source, "ts:src/a.ts#A.v")).toBeNull()
  })
})

describe("two members of one name are one member", () => {
  it("folds two methods even when neither is an accessor", async () => {
    const source = "export class M { m() { a() } m() { b() } }"

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#M", "ts:src/a.ts#M.m"])
    expect((await walkOf(source, "ts:src/a.ts#M.m")).calls.map((c) => c.target)).toEqual(["a", "b"])
  })

  it("keeps a private-name member apart from the public one of the same name", async () => {
    const source = "export class Q { v() { a() } #v() { b() } }"

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#Q", "ts:src/a.ts#Q.#v", "ts:src/a.ts#Q.v"])
    expect((await symbolOf(source, "ts:src/a.ts#Q.v")).derivedBy).not.toContain(
      "declaration-merged",
    )
    expect((await walkOf(source, "ts:src/a.ts#Q.v")).calls.map((c) => c.target)).toEqual(["a"])
    expect((await walkOf(source, "ts:src/a.ts#Q.#v")).calls.map((c) => c.target)).toEqual(["b"])
  })

  it("reports each one's own visibility and signature, whichever is written first", async () => {
    const source = "export class Q { #v(a: number) {} v(c: string) {} }"
    const priv = await symbolOf(source, "ts:src/a.ts#Q.#v")
    const pub = await symbolOf(source, "ts:src/a.ts#Q.v")

    expect([priv.visibility, priv.signature?.inputs]).toEqual([
      "private",
      [{ name: "a", type: "number" }],
    ])
    expect([pub.visibility, pub.signature?.inputs]).toEqual([
      "public",
      [{ name: "c", type: "string" }],
    ])
  })

  it("keeps a static private member's `#` after the static separator", async () => {
    const source = "export class Q { static #v() { a() } static v() { b() } }"

    expect(await idsOf(source)).toEqual(["ts:src/a.ts#Q", "ts:src/a.ts#Q::#v", "ts:src/a.ts#Q::v"])
    expect((await symbolOf(source, "ts:src/a.ts#Q::#v")).visibility).toBe("private")
    expect((await walkOf(source, "ts:src/a.ts#Q::#v")).calls.map((c) => c.target)).toEqual(["a"])
  })
})

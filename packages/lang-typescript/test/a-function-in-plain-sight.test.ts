import type { BodyExtraction, DropHint, SymbolCandidate, WalkContext } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { classifySymbolDropHint, extractSymbols, parseTypescriptFile, walkBody } from "../src/index"
import { makeExtractionCtx, requireTree } from "./fixtures/ctx"

/**
 * Two shapes where the extractor was looking straight at a function and did not see it: one
 * written behind a wrapper the language uses to say nothing about the value, and one written
 * as an argument to a call that registers it.
 *
 * The first is a predicate question — a `parenthesized_expression`, an `as`, a `satisfies` and
 * a `!` all leave the value exactly what it was. The second is a body question: a registration
 * call already has a Symbol, and the handler is what that Symbol runs.
 */

async function symbolsOf(source: string): Promise<SymbolCandidate<Node>[]> {
  const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
  const ctx = makeExtractionCtx("src/a.ts", source)
  return extractSymbols(requireTree(result.tree), ctx)
}

async function symbolOf(source: string, id: string): Promise<SymbolCandidate<Node>> {
  const symbols = await symbolsOf(source)
  const found = symbols.find((s) => s.id === id)
  if (found === undefined) {
    throw new Error(`no Symbol ${id}; have ${symbols.map((s) => s.id).join(", ")}`)
  }
  return found
}

async function walkOf(source: string, id: string): Promise<BodyExtraction> {
  const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
  const ctx = makeExtractionCtx("src/a.ts", source)
  const target = extractSymbols(requireTree(result.tree), ctx).find((s) => s.id === id)
  if (target === undefined) throw new Error(`no Symbol ${id} in fixture`)
  const walkCtx: WalkContext<Node> = { ...ctx, symbol: target }
  return walkBody(target, walkCtx)
}

async function callsOf(source: string, id: string): Promise<string[]> {
  return (await walkOf(source, id)).calls.map((c) => c.target)
}

async function hintOf(source: string, id: string): Promise<DropHint | null> {
  const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
  const ctx = makeExtractionCtx("src/a.ts", source)
  const target = extractSymbols(requireTree(result.tree), ctx).find((s) => s.id === id)
  if (target === undefined) throw new Error(`no Symbol ${id} in fixture`)
  return classifySymbolDropHint(target, ctx)
}

describe("a function behind a wrapper is a function", () => {
  const WRAPPERS: [string, string][] = [
    ["parentheses", "export const h = (() => { doThing() })"],
    ["satisfies", "export const h = ((() => { doThing() })) satisfies H"],
    ["as", "export const h = (() => { doThing() }) as any"],
    ["non-null", "export const h = (() => { doThing() })!"],
    ["nested", "export const h = (((() => { doThing() }) as any) satisfies H)"],
  ]

  for (const [label, source] of WRAPPERS) {
    it(`reads through ${label}`, async () => {
      const symbol = await symbolOf(source, "ts:src/a.ts#h")

      expect(symbol.kind).toBe("function")
      expect(symbol.derivedBy).toContain("variable-assigned-function")
      expect(await callsOf(source, "ts:src/a.ts#h")).toEqual(["doThing"])
    })
  }

  it("reads the signature from the function the wrappers hold", async () => {
    const symbol = await symbolOf(
      "export const h = ((d: string, n: number) => d) as Handler",
      "ts:src/a.ts#h",
    )

    expect(symbol.signature?.inputs.map((i) => [i.name, i.type])).toEqual([
      ["d", "string"],
      ["n", "number"],
    ])
  })

  it("leaves a wrapped value that is not a function a const", async () => {
    const symbol = await symbolOf("export const h = (1) as any", "ts:src/a.ts#h")

    expect(symbol.kind).toBe("const")
  })

  it("stops at a call, which is not a wrapper", async () => {
    // `withAuth(...)` returns a function by convention and nothing in the tree says so. The
    // unwrap is syntactic, so it ends here rather than guessing.
    const symbol = await symbolOf("export const h = (withAuth(() => { q() }))", "ts:src/a.ts#h")

    expect(symbol.kind).toBe("const")
  })

  it("stops at a call it is the callee of, which is not a wrapper either", async () => {
    // An immediately-invoked function: `h` is what the call returned, not the function. The
    // unwrap reads through what surrounds a value, never through what is done to it.
    const symbol = await symbolOf("export const h = (() => { q() })()", "ts:src/a.ts#h")

    expect(symbol.kind).toBe("const")
    expect(symbol.bodyNode).toBeNull()
  })

  it("gives a class field holding a wrapped function its own Symbol", async () => {
    // The predicate is shared, so the class field answers the same question the same way.
    const source = ["export class C {", "  f = (() => { q() })", "}"].join("\n")

    expect((await symbolsOf(source)).map((s) => s.id)).toEqual(["ts:src/a.ts#C", "ts:src/a.ts#C.f"])
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual([])
    expect(await callsOf(source, "ts:src/a.ts#C.f")).toEqual(["q"])
  })

  it("does not read a class of wrapped-arrow fields as a data model", async () => {
    const source = ["export class C {", "  f = (() => { q() })", "}"].join("\n")

    expect(await hintOf(source, "ts:src/a.ts#C")).toBeNull()
  })
})

describe("a registration call's inline handler is its body", () => {
  it("walks the handler written as an argument", async () => {
    const source = ['app.post("/users", async (req, res) => { create(req.body) })'].join("\n")

    expect(await callsOf(source, "ts:src/a.ts#app__post__$users__d0")).toEqual(["create"])
  })

  it("reports the handler's rules as well as its calls", async () => {
    const source = ['app.get("/x", (req, res) => { if (!req.user) throw new E() })'].join("\n")

    expect((await walkOf(source, "ts:src/a.ts#app__get__$x__d0")).rules.map((r) => r.type)).toEqual(
      ["guard", "throw"],
    )
  })

  it("walks a handler written as a function expression", async () => {
    const source = ['app.get("/x", function (req, res) { serve() })'].join("\n")

    expect(await callsOf(source, "ts:src/a.ts#app__get__$x__d0")).toEqual(["serve"])
  })

  it("walks a handler written behind a wrapper", async () => {
    const source = ['app.get("/x", (async (req) => { serve() }) as Handler)'].join("\n")

    expect(await callsOf(source, "ts:src/a.ts#app__get__$x__d0")).toEqual(["serve"])
  })

  it("walks every inline handler, in source order", async () => {
    const source = ["app.use(() => { first() }, () => { second() })"].join("\n")

    expect(await callsOf(source, "ts:src/a.ts#app__use__d0")).toEqual(["first", "second"])
  })

  it("walks both handlers of a chained registration", async () => {
    // The Symbol stands for the whole statement, and both handlers are written in it. Naming
    // it after the leaf method is the existing convention and is not what this changes.
    const source = ['app.route("/x").get(() => { read() }).post(() => { write() })'].join("\n")

    expect(await callsOf(source, "ts:src/a.ts#app__post__d0")).toEqual(["read", "write"])
  })

  it("reads through a wrapper standing in the middle of a chain", async () => {
    // The chain is walked through the same wrappers a value is read through; stopping at
    // the parenthesis would leave the first handler in no Symbol at all.
    const source = '(app.route("/x").get(() => { read() })).post(() => { write() })'

    expect(await callsOf(source, "ts:src/a.ts#app__post__d0")).toEqual(["read", "write"])
  })

  it("walks an awaited registration's handler", async () => {
    const source = ["await app.listen(() => { boot() })"].join("\n")

    expect(await callsOf(source, "ts:src/a.ts#app__listen__d0")).toEqual(["boot"])
  })

  it("says nothing extra for a registration with no function argument", async () => {
    const source = ["app.listen(3000)"].join("\n")
    const symbol = await symbolOf(source, "ts:src/a.ts#app__listen__d0")

    expect(symbol.bodyNode).toBeNull()
    expect(symbol.derivedBy).toEqual(["call-statement:app.listen"])
    expect(await callsOf(source, "ts:src/a.ts#app__listen__d0")).toEqual([])
  })

  it("leaves a handler passed by name where it was", async () => {
    // Nothing is written in the statement to walk. The edge to `handler` is a resolution
    // question, not a body one.
    const source = ['app.get("/x", handler)'].join("\n")
    const symbol = await symbolOf(source, "ts:src/a.ts#app__get__$x__d0")

    expect(symbol.derivedBy).toEqual(["call-statement:app.get", "path-literal:/x"])
    expect(symbol.bodyNode).toBeNull()
    expect(await callsOf(source, "ts:src/a.ts#app__get__$x__d0")).toEqual([])
  })

  it("records why the Symbol has a body, and keeps its signature null", async () => {
    // The Symbol is the registration, not the handler: a route has no parameters of its own,
    // and reading the handler's would report the framework's callback shape as the route's API.
    const source = ['app.get("/x", (req, res) => { serve() })'].join("\n")
    const symbol = await symbolOf(source, "ts:src/a.ts#app__get__$x__d0")

    expect(symbol.derivedBy).toContain("inline-handler")
    expect(symbol.signature).toBeNull()
  })
})

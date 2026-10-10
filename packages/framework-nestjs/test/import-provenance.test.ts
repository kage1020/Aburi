import { describe, expect, it } from "vitest"
import { classifyNestjsSymbol } from "../src/index"
import {
  makeCandidate,
  makeCtx,
  makeDecorator,
  makeImport,
  makeQualifiedDecorator,
} from "./fixtures/symbol"

const NEST = "@nestjs/common"

describe("aliased decorators resolve through the import edge", () => {
  it("classifies @Ctrl when the file imports Controller as Ctrl", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "BController",
        decorators: [makeDecorator("Ctrl", ["'/b'"])],
      }),
      makeCtx({ imports: [makeImport(NEST, ["Controller as Ctrl"])] }),
    )
    expect(result?.extKind).toBe("framework:nestjs:controller")
    expect(result?.decoratorBoundaries).toEqual({ Ctrl: true })
    expect(result?.derivedBy).toBe("framework:nestjs:controller")
    expect(result?.confidence).toBeUndefined()
  })

  it("names the route after the imported verb, not the local alias", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({ kind: "method", name: "B.list", decorators: [makeDecorator("Fetch")] }),
      makeCtx({ imports: [makeImport(NEST, ["Get as Fetch"])] }),
    )
    expect(result?.extKind).toBe("framework:nestjs:route")
    expect(result?.decoratorBoundaries).toEqual({ Fetch: true })
    expect(result?.derivedBy).toBe("framework:nestjs:route:Get")
  })

  it("resolves an aliased cross-cutting handler without assigning a route extKind", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({ kind: "method", name: "B.run", decorators: [makeDecorator("Guarded")] }),
      makeCtx({ imports: [makeImport(NEST, ["UseGuards as Guarded"])] }),
    )
    expect(result?.extKind).toBeUndefined()
    expect(result?.decoratorBoundaries).toEqual({ Guarded: true })
    expect(result?.derivedBy).toBe("framework:nestjs:handler:UseGuards")
  })

  it("resolves an aliased pattern handler from @nestjs/microservices", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({ kind: "method", name: "B.on", decorators: [makeDecorator("OnMsg")] }),
      makeCtx({
        imports: [makeImport("@nestjs/microservices", ["MessagePattern as OnMsg"])],
      }),
    )
    expect(result?.extKind).toBe("framework:nestjs:route")
    expect(result?.derivedBy).toBe("framework:nestjs:route:MessagePattern")
  })

  it("matches on the imported name, so a local name that merely looks like vocabulary misses", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "Thing",
        decorators: [makeDecorator("Controller")],
      }),
      makeCtx({ imports: [makeImport("./thing", ["Thing as Controller"])] }),
    )
    expect(result).toBeNull()
  })

  it("takes a method's classification away the same way", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({ kind: "method", name: "C.list", decorators: [makeDecorator("Get")] }),
      makeCtx({ imports: [makeImport(NEST, ["Controller as Get"])] }),
    )
    expect(result).toBeNull()
  })
})

describe("provenance decides how far the classification is trusted", () => {
  it("keeps the implicit high confidence for a decorator imported from @nestjs/*", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({ kind: "class", name: "C", decorators: [makeDecorator("Controller")] }),
      makeCtx({ imports: [makeImport(NEST, ["Controller"])] }),
    )
    expect(result?.extKind).toBe("framework:nestjs:controller")
    expect(result?.confidence).toBeUndefined()
  })

  it("downgrades a decorator the file attributes to a competing library", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({ kind: "class", name: "C", decorators: [makeDecorator("Controller")] }),
      makeCtx({ imports: [makeImport("routing-controllers", ["Controller"])] }),
    )
    expect(result?.extKind).toBe("framework:nestjs:controller")
    expect(result?.confidence).toBe("medium")
  })

  it("downgrades a re-export barrel, which is indistinguishable from a foreign package", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({ kind: "method", name: "C.list", decorators: [makeDecorator("Get")] }),
      makeCtx({ imports: [makeImport("../common", ["Get"])] }),
    )
    expect(result?.extKind).toBe("framework:nestjs:route")
    expect(result?.confidence).toBe("medium")
  })

  it("reads a default-imported decorator by the name the file gave it, at medium", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({ kind: "class", name: "C", decorators: [makeDecorator("Controller")] }),
      makeCtx({ imports: [makeImport("./decorators", ["default as Controller"])] }),
    )
    expect(result?.extKind).toBe("framework:nestjs:controller")
    expect(result?.confidence).toBe("medium")
  })

  it("reads a decorator default-imported from NestJS by the name the file gave it, at high", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({ kind: "method", name: "C.list", decorators: [makeDecorator("Get")] }),
      makeCtx({ imports: [makeImport(NEST, ["default as Get"])] }),
    )
    expect(result?.extKind).toBe("framework:nestjs:route")
    expect(result?.derivedBy).toBe("framework:nestjs:route:Get")
    expect(result?.confidence).toBeUndefined()
  })

  it("leaves a decorator the file says nothing about at high confidence", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({ kind: "class", name: "C", decorators: [makeDecorator("Controller")] }),
      makeCtx({ imports: [makeImport("./unrelated", ["helper"])] }),
    )
    expect(result?.extKind).toBe("framework:nestjs:controller")
    expect(result?.confidence).toBeUndefined()
  })

  it.each([
    "@nestjs/common",
    "@nestjs/microservices",
    "@nestjs/websockets",
    "@nestjs/graphql",
  ])("treats %s as NestJS provenance", (source) => {
    const result = classifyNestjsSymbol(
      makeCandidate({ kind: "class", name: "C", decorators: [makeDecorator("Injectable")] }),
      makeCtx({ imports: [makeImport(source, ["Injectable"])] }),
    )
    expect(result?.confidence).toBeUndefined()
  })

  it.each([
    "@nestjsx/common",
    "nestjs",
    "@nest/common",
  ])("does not read %s as the NestJS scope", (source) => {
    const result = classifyNestjsSymbol(
      makeCandidate({ kind: "class", name: "C", decorators: [makeDecorator("Injectable")] }),
      makeCtx({ imports: [makeImport(source, ["Injectable"])] }),
    )
    expect(result?.confidence).toBe("medium")
  })

  it.each([
    [
      "NestJS edge first",
      [makeImport(NEST, ["Controller"], 1), makeImport("./x", ["Controller"], 2)],
    ],
    [
      "NestJS edge second",
      [makeImport("./x", ["Controller"], 1), makeImport(NEST, ["Controller"], 2)],
    ],
  ])("resolves a name bound twice in favour of the NestJS edge (%s)", (_label, imports) => {
    const result = classifyNestjsSymbol(
      makeCandidate({ kind: "class", name: "C", decorators: [makeDecorator("Controller")] }),
      makeCtx({ imports }),
    )
    expect(result?.confidence).toBeUndefined()
  })

  it("reads a namespace import through the decorator's own receiver", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "C",
        decorators: [makeQualifiedDecorator("nest", "Controller")],
      }),
      makeCtx({ imports: [{ ...makeImport(NEST, "*"), namespaceBinding: "nest" }] }),
    )
    expect(result?.extKind).toBe("framework:nestjs:controller")
    expect(result?.decoratorBoundaries).toEqual({ "nest.Controller": true })
    expect(result?.confidence).toBeUndefined()
  })

  it("takes the confidence from the decorator that won, not from the ones that lost", () => {
    const nestFirst = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "C",
        decorators: [makeDecorator("Controller", [], 1), makeDecorator("Injectable", [], 2)],
      }),
      makeCtx({
        imports: [makeImport(NEST, ["Controller"], 1), makeImport("./di", ["Injectable"], 2)],
      }),
    )
    expect(nestFirst?.extKind).toBe("framework:nestjs:controller")
    expect(nestFirst?.confidence).toBeUndefined()

    const foreignFirst = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "C",
        decorators: [makeDecorator("Injectable", [], 1), makeDecorator("Controller", [], 2)],
      }),
      makeCtx({
        imports: [makeImport(NEST, ["Controller"], 1), makeImport("./di", ["Injectable"], 2)],
      }),
    )
    expect(foreignFirst?.extKind).toBe("framework:nestjs:provider")
    expect(foreignFirst?.confidence).toBe("medium")
    // The decorator that lost still contributes its boundary flag, whatever its provenance.
    expect(foreignFirst?.decoratorBoundaries).toEqual({ Injectable: true, Controller: true })
  })

  it.each([
    [
      "route decorator from a foreign module",
      [makeDecorator("UseGuards", [], 1), makeDecorator("Get", [], 2)],
      [makeImport(NEST, ["UseGuards"], 1), makeImport("./local", ["Get"], 2)],
      "medium",
    ],
    [
      "handler decorator from a foreign module",
      [makeDecorator("Get", [], 1), makeDecorator("UseGuards", [], 2)],
      [makeImport(NEST, ["Get"], 1), makeImport("./local", ["UseGuards"], 2)],
      undefined,
    ],
  ] as const)("takes a method's confidence from the route slot, not the handler slot (%s)", (_label, decorators, imports, confidence) => {
    const result = classifyNestjsSymbol(
      makeCandidate({ kind: "method", name: "C.list", decorators: [...decorators] }),
      makeCtx({ imports: [...imports] }),
    )
    expect(result?.extKind).toBe("framework:nestjs:route")
    expect(result?.derivedBy).toBe("framework:nestjs:route:Get")
    expect(result?.confidence).toBe(confidence)
    expect(result?.decoratorBoundaries).toEqual({ Get: true, UseGuards: true })
  })

  it("downgrades a namespace import from a competing library, as the named form does", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "C",
        decorators: [makeQualifiedDecorator("rc", "Controller")],
      }),
      makeCtx({
        imports: [{ ...makeImport("routing-controllers", "*"), namespaceBinding: "rc" }],
      }),
    )
    expect(result?.extKind).toBe("framework:nestjs:controller")
    expect(result?.confidence).toBe("medium")
  })

  it("reads the receiver rather than a same-named binding from somewhere else", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "C",
        decorators: [makeQualifiedDecorator("tsed", "Controller")],
      }),
      makeCtx({
        imports: [
          makeImport(NEST, ["Controller"], 1),
          { ...makeImport("@tsed/common", "*", 2), namespaceBinding: "tsed" },
        ],
      }),
    )
    expect(result?.extKind).toBe("framework:nestjs:controller")
    expect(result?.confidence).toBe("medium")
  })

  it("resolves a nested receiver on its first segment, which is the part in scope", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "C",
        decorators: [makeQualifiedDecorator("ns.deep", "Controller")],
      }),
      makeCtx({
        imports: [{ ...makeImport("routing-controllers", "*"), namespaceBinding: "ns" }],
      }),
    )
    expect(result?.confidence).toBe("medium")
  })

  it("leaves a receiver no edge mentions in the unbound tier", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "C",
        decorators: [makeQualifiedDecorator("local", "Controller")],
      }),
      makeCtx({ imports: [{ ...makeImport(NEST, "*"), namespaceBinding: "nest" }] }),
    )
    expect(result?.extKind).toBe("framework:nestjs:controller")
    expect(result?.confidence).toBeUndefined()
  })

  it.each([
    ["NestJS edge first", NEST, "routing-controllers"],
    ["NestJS edge second", "routing-controllers", NEST],
  ])("resolves a namespace bound twice in favour of the NestJS edge (%s)", (_label, first, second) => {
    // Reachable through re-exports, the way a doubly-bound name is. Same tiebreak.
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "C",
        decorators: [makeQualifiedDecorator("ns", "Controller")],
      }),
      makeCtx({
        imports: [
          { ...makeImport(first, "*", 1), namespaceBinding: "ns" },
          { ...makeImport(second, "*", 2), namespaceBinding: "ns" },
        ],
      }),
    )
    expect(result?.confidence).toBeUndefined()
  })

  it("ignores a namespace edge that binds nothing in scope", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "C",
        decorators: [makeQualifiedDecorator("nest", "Controller")],
      }),
      makeCtx({ imports: [makeImport(NEST, "*")] }),
    )
    expect(result?.extKind).toBe("framework:nestjs:controller")
    expect(result?.confidence).toBeUndefined()
  })

  it("reads a receiver bound by a default import, as it reads a namespace one", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "C",
        decorators: [makeQualifiedDecorator("nest", "Controller")],
      }),
      makeCtx({ imports: [makeImport(NEST, ["nest"])] }),
    )
    expect(result?.extKind).toBe("framework:nestjs:controller")
    expect(result?.confidence).toBeUndefined()
  })

  it("downgrades a receiver a competing library's default import bound", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "C",
        decorators: [makeQualifiedDecorator("tsed", "Controller")],
      }),
      makeCtx({ imports: [makeImport("@tsed/common", ["tsed"])] }),
    )
    expect(result?.extKind).toBe("framework:nestjs:controller")
    expect(result?.confidence).toBe("medium")
  })

  it("prefers the namespace binding when both kinds of edge bind the receiver", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "C",
        decorators: [makeQualifiedDecorator("nest", "Controller")],
      }),
      makeCtx({
        imports: [
          { ...makeImport(NEST, "*", 1), namespaceBinding: "nest" },
          makeImport("@tsed/common", ["nest"], 2),
        ],
      }),
    )
    expect(result?.confidence).toBeUndefined()
  })

  it("does not read a qualified decorator's leaf through the named-import index", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "C",
        decorators: [makeQualifiedDecorator("tsed", "Controller")],
      }),
      makeCtx({ imports: [makeImport(NEST, ["Controller"])] }),
    )
    expect(result?.extKind).toBe("framework:nestjs:controller")
    expect(result?.confidence).toBeUndefined()
  })

  it("throws on a namespace edge whose binding is present but empty", () => {
    expect(() =>
      classifyNestjsSymbol(
        makeCandidate({
          kind: "class",
          name: "C",
          decorators: [makeQualifiedDecorator("nest", "Controller")],
        }),
        makeCtx({ imports: [{ ...makeImport(NEST, "*"), namespaceBinding: "" }] }),
      ),
    ).toThrow(/namespaceBinding is empty/)
  })

  it.each([
    ["", "empty"],
    [".a", "leading dot"],
  ])("throws on a qualifier of %s (%s), which the schema forbids", (qualifier) => {
    expect(() =>
      classifyNestjsSymbol(
        makeCandidate({
          kind: "class",
          name: "C",
          decorators: [{ ...makeDecorator("Controller"), qualifier }],
        }),
        makeCtx({ imports: [makeImport(NEST, ["Controller"])] }),
      ),
    ).toThrow(/unusable qualifier/)
  })

  it("keys a boundary on the written form, so a shared leaf does not flag both decorators", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "C",
        decorators: [makeDecorator("Ctrl", [], 1), makeQualifiedDecorator("x", "Ctrl", [], 2)],
      }),
      makeCtx({ imports: [makeImport(NEST, ["Controller as Ctrl"])] }),
    )
    expect(result?.extKind).toBe("framework:nestjs:controller")
    expect(result?.decoratorBoundaries).toEqual({ Ctrl: true })
  })

  it("takes a method's confidence from the slot that decided it, across the two forms", () => {
    const imports = [
      { ...makeImport("@tsed/common", "*", 1), namespaceBinding: "tsed" },
      makeImport(NEST, ["UseGuards"], 2),
    ]
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "method",
        name: "C.list",
        decorators: [
          makeQualifiedDecorator("tsed", "Get", [], 1),
          makeDecorator("UseGuards", [], 2),
        ],
      }),
      makeCtx({ imports }),
    )
    expect(result?.extKind).toBe("framework:nestjs:route")
    expect(result?.derivedBy).toBe("framework:nestjs:route:Get")
    expect(result?.decoratorBoundaries).toEqual({ "tsed.Get": true, UseGuards: true })
    expect(result?.confidence).toBe("medium")
  })

  it("names a qualified route after its leaf, which a namespace import cannot rename", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "method",
        name: "C.list",
        decorators: [makeQualifiedDecorator("nest", "Get")],
      }),
      makeCtx({ imports: [{ ...makeImport(NEST, "*"), namespaceBinding: "nest" }] }),
    )
    expect(result?.extKind).toBe("framework:nestjs:route")
    expect(result?.derivedBy).toBe("framework:nestjs:route:Get")
    expect(result?.decoratorBoundaries).toEqual({ "nest.Get": true })
    expect(result?.confidence).toBeUndefined()
  })

  it("resolves each file against its own edges when one plugin classifies many files", () => {
    const candidate = makeCandidate({
      kind: "class",
      name: "C",
      decorators: [makeDecorator("Ctrl")],
    })
    const aliased = classifyNestjsSymbol(
      candidate,
      makeCtx({ path: "src/one.ts", imports: [makeImport(NEST, ["Controller as Ctrl"])] }),
    )
    const unbound = classifyNestjsSymbol(candidate, makeCtx({ path: "src/two.ts", imports: [] }))

    expect(aliased?.extKind).toBe("framework:nestjs:controller")
    expect(unbound).toBeNull()
  })

  it("refuses an import edge whose module specifier is empty", () => {
    expect(() =>
      classifyNestjsSymbol(
        makeCandidate({ kind: "class", name: "C", decorators: [makeDecorator("Controller")] }),
        makeCtx({ imports: [makeImport("", ["Controller"], 7)] }),
      ),
    ).toThrow(/framework-nestjs \(src\/a\.ts, line 7\).*ImportEdge\.source is empty/)
  })

  it("refuses a broken edge sitting behind one that would have answered", () => {
    expect(() =>
      classifyNestjsSymbol(
        makeCandidate({ kind: "class", name: "C", decorators: [makeDecorator("Controller")] }),
        makeCtx({ imports: [makeImport(NEST, ["Controller"], 1), makeImport("", ["X"], 9)] }),
      ),
    ).toThrow(/line 9.*ImportEdge\.source is empty/)
  })

  it.each([
    [" as Ctrl", "an empty exported half"],
    ["Controller as ", "an empty local half"],
  ])("refuses a symbols entry with %s", (entry) => {
    expect(() =>
      classifyNestjsSymbol(
        makeCandidate({ kind: "class", name: "C", decorators: [makeDecorator("Ctrl")] }),
        makeCtx({ imports: [makeImport(NEST, [entry], 3)] }),
      ),
    ).toThrow(/framework-nestjs \(src\/a\.ts, line 3\).*has an empty half/)
  })

  it("does not read the import list for a Symbol that carries no decorators", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({ kind: "class", name: "Plain", decorators: [] }),
      makeCtx({ imports: [makeImport("", ["Controller"])] }),
    )
    expect(result).toBeNull()
  })
})

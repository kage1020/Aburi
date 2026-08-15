import { describe, expect, it } from "vitest"
import { classifyNestjsSymbol } from "../src/index"
import { makeCandidate, makeCtx, makeDecorator, makeImport } from "./fixtures/symbol"

/**
 * What the file's import edges say about a decorator's written name, and what the
 * classifier does with it.
 *
 * Two directions are at stake and they pull opposite ways. A decorator renamed on import
 * (`import { Controller as Ctrl }`) is a NestJS boundary written under a name that is not
 * in any table, and matching the written name alone loses it. A decorator that shares a
 * name with NestJS vocabulary but came from a competing library is not a NestJS boundary
 * at all, and matching the written name alone claims it.
 *
 * The classification is keyed on the name the binding was **imported** under; the
 * `decoratorBoundaries` map is keyed on the name the source **wrote**, because that is what
 * the core matches against `Decorator.name` when it folds the result back in.
 */

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
    // The class case above pins the loss on the class side. `Controller` is not method
    // vocabulary, so resolving `@Get` to it drops the route rather than renaming it.
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

  it("reads a namespace import as binding nothing, so the leaf name still classifies", () => {
    // `import * as nest from "@nestjs/common"` + `@nest.Controller()`. The language plugin
    // hands the framework the leaf identifier, and the edge carries no named binding, so the
    // decorator is resolved as an unbound name.
    const result = classifyNestjsSymbol(
      makeCandidate({ kind: "class", name: "C", decorators: [makeDecorator("Controller")] }),
      makeCtx({ imports: [{ ...makeImport(NEST, "*"), namespaceBinding: "nest" }] }),
    )
    expect(result?.extKind).toBe("framework:nestjs:controller")
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
    // `classifyMethod` fills two winner slots and the route one decides the answer, so the
    // handler's provenance must not reach the result in either direction.
    const result = classifyNestjsSymbol(
      makeCandidate({ kind: "method", name: "C.list", decorators: [...decorators] }),
      makeCtx({ imports: [...imports] }),
    )
    expect(result?.extKind).toBe("framework:nestjs:route")
    expect(result?.derivedBy).toBe("framework:nestjs:route:Get")
    expect(result?.confidence).toBe(confidence)
    expect(result?.decoratorBoundaries).toEqual({ Get: true, UseGuards: true })
  })

  it("trusts a namespace import from a competing library, which is the limit of this reading", () => {
    // `import * as rc from "routing-controllers"` + `@rc.Controller()`. The named-import form
    // of the same decorator downgrades to `medium`; this one cannot, because the edge binds
    // only the namespace object and `Decorator` carries no qualifier to tie the leaf back to
    // it. Pinned as the accepted limit rather than left to be rediscovered as a bug.
    const result = classifyNestjsSymbol(
      makeCandidate({ kind: "class", name: "C", decorators: [makeDecorator("Controller")] }),
      makeCtx({
        imports: [{ ...makeImport("routing-controllers", "*"), namespaceBinding: "rc" }],
      }),
    )
    expect(result?.extKind).toBe("framework:nestjs:controller")
    expect(result?.confidence).toBeUndefined()
  })

  it("resolves each file against its own edges when one plugin classifies many files", () => {
    // The index is derived from `ctx.imports`; deriving it once per file must not let one
    // file's answer stand in for another's.
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
    // The whole list is indexed before any name is resolved, so the throw cannot depend on
    // where the broken edge sits relative to the one that satisfies the lookup.
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
    // Either half empty means a canonical name that matches no table, which would drop the
    // classification silently — the failure `assertDecoratorName` already refuses to allow
    // from the written-name side.
    expect(() =>
      classifyNestjsSymbol(
        makeCandidate({ kind: "class", name: "C", decorators: [makeDecorator("Ctrl")] }),
        makeCtx({ imports: [makeImport(NEST, [entry], 3)] }),
      ),
    ).toThrow(/framework-nestjs \(src\/a\.ts, line 3\).*has an empty half/)
  })

  it("does not read the import list for a Symbol that carries no decorators", () => {
    // The empty-source guard is the observable proxy: a broken edge is only reached when
    // there is a name to resolve, so a decorator-less Symbol must pass through it untouched.
    const result = classifyNestjsSymbol(
      makeCandidate({ kind: "class", name: "Plain", decorators: [] }),
      makeCtx({ imports: [makeImport("", ["Controller"])] }),
    )
    expect(result).toBeNull()
  })
})

import { CoreError } from "@aburi/core"
import { describe, expect, it } from "vitest"
import { classifyNestjsSymbol } from "../src/index"
import { makeCandidate, makeCtx, makeDecorator } from "./fixtures/symbol"

describe("classifyNestjsSymbol — class decorators", () => {
  it("NF1: @Module → framework:nestjs:module", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "AppModule",
        decorators: [makeDecorator("Module", ["{}"])],
      }),
      makeCtx(),
    )
    expect(result?.extKind).toBe("framework:nestjs:module")
    expect(result?.decoratorBoundaries).toEqual({ Module: true })
    expect(result?.derivedBy).toBe("framework:nestjs:module")
  })

  it("NF2: @Controller → framework:nestjs:controller with Controller flagged boundary", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "InvoiceController",
        decorators: [makeDecorator("Controller", ["'/invoices'"])],
      }),
      makeCtx(),
    )
    expect(result?.extKind).toBe("framework:nestjs:controller")
    expect(result?.decoratorBoundaries).toEqual({ Controller: true })
    expect(result?.derivedBy).toBe("framework:nestjs:controller")
  })

  it("NF3: @Injectable → framework:nestjs:provider", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "InvoiceService",
        decorators: [makeDecorator("Injectable")],
      }),
      makeCtx(),
    )
    expect(result?.extKind).toBe("framework:nestjs:provider")
    expect(result?.decoratorBoundaries).toEqual({ Injectable: true })
    expect(result?.derivedBy).toBe("framework:nestjs:provider")
  })

  it("NF4: @Catch → framework:nestjs:filter", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "HttpExceptionFilter",
        decorators: [makeDecorator("Catch", ["HttpException"])],
      }),
      makeCtx(),
    )
    expect(result?.extKind).toBe("framework:nestjs:filter")
  })

  it("returns null for a class with no NestJS decorators", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({ kind: "class", name: "Plain", decorators: [] }),
      makeCtx(),
    )
    expect(result).toBeNull()
  })

  it("ignores unrelated decorators without misclassifying the class", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "Utility",
        decorators: [makeDecorator("SomeOtherThing")],
      }),
      makeCtx(),
    )
    expect(result).toBeNull()
  })

  it("first-in-source-order wins when multiple class-level decorators appear", () => {
    // Decorators are read in the order the language plugin emits them (line-sorted).
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "class",
        name: "Hybrid",
        decorators: [makeDecorator("Injectable", [], 1), makeDecorator("Controller", ["'/x'"], 2)],
      }),
      makeCtx(),
    )
    // Injectable came first on line 1 so provider wins even though Controller is present.
    expect(result?.extKind).toBe("framework:nestjs:provider")
    expect(result?.decoratorBoundaries).toEqual({
      Injectable: true,
      Controller: true,
    })
  })
})

describe("classifyNestjsSymbol — method decorators", () => {
  it("NF5: @Post('/invoices') → framework:nestjs:route + boundary on the method", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "method",
        name: "InvoiceController.create",
        decorators: [makeDecorator("Post", ["'/invoices'"])],
      }),
      makeCtx(),
    )
    expect(result?.extKind).toBe("framework:nestjs:route")
    expect(result?.decoratorBoundaries).toEqual({ Post: true })
    expect(result?.derivedBy).toBe("framework:nestjs:route:Post")
  })

  it("NF6: all eight HTTP method decorators map to route + boundary", () => {
    for (const name of ["Get", "Post", "Put", "Delete", "Patch", "Options", "Head", "All"]) {
      const result = classifyNestjsSymbol(
        makeCandidate({
          kind: "method",
          name: `C.method_${name}`,
          decorators: [makeDecorator(name)],
        }),
        makeCtx(),
      )
      expect(result?.extKind).toBe("framework:nestjs:route")
      expect(result?.decoratorBoundaries?.[name]).toBe(true)
    }
  })

  it("NF7: handler-only decorators mark boundary but do NOT claim the route extKind", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "method",
        name: "S.wrapped",
        decorators: [makeDecorator("UseGuards", ["AuthGuard"])],
      }),
      makeCtx(),
    )
    expect(result?.decoratorBoundaries).toEqual({ UseGuards: true })
    expect(result?.extKind).toBeUndefined()
    expect(result?.derivedBy).toBe("framework:nestjs:handler:UseGuards")
  })

  it.each([
    "UseGuards",
    "UseInterceptors",
    "UsePipes",
    "UseFilters",
  ])("NF7 variant: %s produces a handler-only classification with no extKind", (name) => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "method",
        name: `S.method_${name}`,
        decorators: [makeDecorator(name, ["Something"])],
      }),
      makeCtx(),
    )
    expect(result?.extKind).toBeUndefined()
    expect(result?.decoratorBoundaries?.[name]).toBe(true)
    expect(result?.derivedBy).toBe(`framework:nestjs:handler:${name}`)
  })

  it("NF8: mixing HTTP method + Guard produces route extKind AND both boundaries", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "method",
        name: "C.protected",
        decorators: [
          makeDecorator("UseGuards", ["AuthGuard"], 1),
          makeDecorator("Post", ["'/x'"], 2),
        ],
      }),
      makeCtx(),
    )
    expect(result?.extKind).toBe("framework:nestjs:route")
    expect(result?.decoratorBoundaries).toEqual({ UseGuards: true, Post: true })
    // The route extKind is what a user actually sees, so the derivedBy anchors on that.
    // derivedBy preserves the source decorator identifier verbatim (no case transform).
    expect(result?.derivedBy).toBe("framework:nestjs:route:Post")
  })

  it("NF9: microservice pattern decorators are route-equivalent boundaries", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "method",
        name: "H.handle",
        decorators: [makeDecorator("MessagePattern", ["'user.created'"])],
      }),
      makeCtx(),
    )
    expect(result?.extKind).toBe("framework:nestjs:route")
    expect(result?.decoratorBoundaries?.MessagePattern).toBe(true)
    expect(result?.derivedBy).toBe("framework:nestjs:route:MessagePattern")
  })

  it.each([
    "MessagePattern",
    "EventPattern",
    "SubscribeMessage",
  ])("NF9 variant: %s claims route extKind and boundary", (name) => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "method",
        name: `H.method_${name}`,
        decorators: [makeDecorator(name, ["'x'"])],
      }),
      makeCtx(),
    )
    expect(result?.extKind).toBe("framework:nestjs:route")
    expect(result?.decoratorBoundaries?.[name]).toBe(true)
    expect(result?.derivedBy).toBe(`framework:nestjs:route:${name}`)
  })

  it("returns null for a method without any recognized decorator", () => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind: "method",
        name: "S.internal",
        decorators: [makeDecorator("Deprecated")],
      }),
      makeCtx(),
    )
    expect(result).toBeNull()
  })
})

describe("classifyNestjsSymbol — derivedBy identifier policy", () => {
  it("preserves the source decorator identifier verbatim across both route and handler branches", () => {
    // Verbatim policy: no case transform on either side, so a grep for the decorator
    // name lands on both the source `.ts` and the emitted derivedBy string.
    const route = classifyNestjsSymbol(
      makeCandidate({
        kind: "method",
        name: "C.post",
        decorators: [makeDecorator("Post", ["'/x'"])],
      }),
      makeCtx(),
    )
    const handler = classifyNestjsSymbol(
      makeCandidate({
        kind: "method",
        name: "C.protected",
        decorators: [makeDecorator("UseGuards", ["AuthGuard"])],
      }),
      makeCtx(),
    )
    expect(route?.derivedBy).toBe("framework:nestjs:route:Post")
    expect(handler?.derivedBy).toBe("framework:nestjs:handler:UseGuards")
  })
})

describe("classifyNestjsSymbol — non-classifiable Symbol kinds", () => {
  it.each([
    "function",
    "interface",
    "type",
    "const",
    "namespace",
    "enum",
  ] as const)("returns null for kind=%s so other classifiers can fire", (kind) => {
    const result = classifyNestjsSymbol(
      makeCandidate({
        kind,
        name: "X",
        decorators: [makeDecorator("Controller")],
      }),
      makeCtx(),
    )
    expect(result).toBeNull()
  })
})

describe("classifyNestjsSymbol — empty decorator name fail-fast", () => {
  it.each([
    "class",
    "method",
  ] as const)("throws CoreError when a %s Symbol has a decorator with an empty name", (kind) => {
    let caught: unknown
    try {
      classifyNestjsSymbol(
        makeCandidate({
          kind,
          id: "ts:src/a.ts#Broken",
          name: "Broken",
          decorators: [makeDecorator("")],
        }),
        makeCtx(),
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(CoreError)
    expect((caught as CoreError).code).toBe("anonymous-symbol-id-attempted")
    expect((caught as CoreError).value).toBe("ts:src/a.ts#Broken")
  })
})

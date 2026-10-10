import { describe, expectTypeOf, it } from "vitest"
import type {
  ComponentId,
  Dependency,
  DependencyEndpoint,
  LangManifest,
  SliceId,
  SliceRecord,
  SourceRange,
  Symbol,
  SymbolCandidate,
  SymbolId,
  WrittenSourceRange,
} from "../src/index"

type Assignable<From, To> = [From] extends [To] ? true : false

describe("id brands", () => {
  it("keeps SymbolId, ComponentId and SliceId mutually distinct", () => {
    expectTypeOf<Assignable<SymbolId, ComponentId>>().toEqualTypeOf<false>()
    expectTypeOf<Assignable<ComponentId, SymbolId>>().toEqualTypeOf<false>()
    expectTypeOf<Assignable<SymbolId, SliceId>>().toEqualTypeOf<false>()
    expectTypeOf<Assignable<SliceId, SymbolId>>().toEqualTypeOf<false>()
    expectTypeOf<Assignable<ComponentId, SliceId>>().toEqualTypeOf<false>()
    expectTypeOf<Assignable<SliceId, ComponentId>>().toEqualTypeOf<false>()
  })

  it("refuses a bare string as an id, but reads every id as a string", () => {
    expectTypeOf<Assignable<string, SymbolId>>().toEqualTypeOf<false>()
    expectTypeOf<Assignable<string, ComponentId>>().toEqualTypeOf<false>()
    expectTypeOf<Assignable<string, SliceId>>().toEqualTypeOf<false>()
    expectTypeOf<Assignable<SymbolId, string>>().toEqualTypeOf<true>()
    expectTypeOf<Assignable<ComponentId, string>>().toEqualTypeOf<true>()
    expectTypeOf<Assignable<SliceId, string>>().toEqualTypeOf<true>()
  })

  it("refuses a slice id built by concatenation", () => {
    expectTypeOf<Assignable<`slice:${string}`, SliceId>>().toEqualTypeOf<false>()
  })

  it("lets a Dependency endpoint hold either id kind but not a bare string", () => {
    expectTypeOf<Dependency["from"]>().toEqualTypeOf<DependencyEndpoint>()
    expectTypeOf<Dependency["to"]>().toEqualTypeOf<DependencyEndpoint>()
    expectTypeOf<Assignable<SymbolId, DependencyEndpoint>>().toEqualTypeOf<true>()
    expectTypeOf<Assignable<ComponentId, DependencyEndpoint>>().toEqualTypeOf<true>()
    expectTypeOf<Assignable<string, DependencyEndpoint>>().toEqualTypeOf<false>()
  })

  it("shares SymbolId between the IR and the diff", () => {
    expectTypeOf<SliceRecord["members"]>().toEqualTypeOf<SymbolId[]>()
    expectTypeOf<SliceRecord["id"]>().toEqualTypeOf<SliceId>()
  })

  it("hands core an already-validated Symbol id from a plugin", () => {
    expectTypeOf<SymbolCandidate["id"]>().toEqualTypeOf<SymbolId>()
    expectTypeOf<Symbol["id"]>().toEqualTypeOf<SymbolId>()
    expectTypeOf<Symbol["component"]>().toEqualTypeOf<ComponentId | null | undefined>()
  })
})

describe("plugin-facing shapes", () => {
  it("makes a plugin write a SourceRange stricter than the one it reads", () => {
    expectTypeOf<SymbolCandidate["source"]>().toEqualTypeOf<WrittenSourceRange>()
    expectTypeOf<Assignable<SourceRange, WrittenSourceRange>>().toEqualTypeOf<false>()
    expectTypeOf<Assignable<WrittenSourceRange, SourceRange>>().toEqualTypeOf<true>()
  })

  it("narrows a manifest by its type discriminator", () => {
    expectTypeOf<LangManifest["type"]>().toEqualTypeOf<"lang">()
    expectTypeOf<
      Assignable<{ type: "effects" }, Pick<LangManifest, "type">>
    >().toEqualTypeOf<false>()
  })
})

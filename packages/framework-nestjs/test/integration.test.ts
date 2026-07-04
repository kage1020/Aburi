import {
  extractSymbols as extractTypescriptSymbols,
  parseTypescriptFile,
} from "@aburi/lang-typescript"
import type { ExtractionContext, SourceFile } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { classifyNestjsSymbol } from "../src/index"

/**
 * End-to-end: parse a TypeScript source with `@aburi/lang-typescript`, run
 * `classifyNestjsSymbol` on every SymbolCandidate the language plugin emits, and confirm
 * that the framework plugin correctly assigns extKinds and boundary flags. Locks the wire
 * between decorator extraction in the language plugin and framework classification here.
 */

async function classifyEach(source: string) {
  const parseResult = await parseTypescriptFile({ path: "src/x.ts", content: source })
  const tree = parseResult.tree
  if (tree === null) throw new Error("parse returned null")
  const file: SourceFile = { path: "src/x.ts", content: source }
  const ctx: ExtractionContext = {
    file,
    registry: {
      findEffect: () => null,
      findExtKind: () => null,
      findFramework: () => null,
      findDerivedByOwner: () => null,
      isEffectOwnedBy: () => false,
      isExtKindOwnedBy: () => false,
      listEffects: () => [],
      listExtKinds: () => [],
      listFrameworks: () => [],
      listPlugins: () => [],
      assertEffectDeclared: () => {},
      assertExtKindDeclared: () => {},
    },
    config: {},
  }
  const candidates = extractTypescriptSymbols(tree, ctx)
  return candidates.map((candidate) => ({
    id: candidate.id,
    classification: classifyNestjsSymbol(candidate, ctx),
  }))
}

describe("integration — lang-typescript → framework-nestjs", () => {
  it("classifies a real @Controller class through the language plugin", async () => {
    const results = await classifyEach(
      "@Controller('/invoices')\nexport class InvoiceController {\n  @Post('/x')\n  create() {}\n}",
    )
    const cls = results.find((r) => r.id.endsWith("#InvoiceController"))
    const method = results.find((r) => r.id.endsWith("#InvoiceController.create"))
    expect(cls?.classification?.extKind).toBe("framework:nestjs:controller")
    expect(method?.classification?.extKind).toBe("framework:nestjs:route")
    expect(method?.classification?.decoratorBoundaries).toEqual({ Post: true })
  })

  it("classifies @Module and @Injectable classes without misclassifying siblings", async () => {
    const results = await classifyEach(
      "import { X } from './x'\n@Module({})\nexport class AppModule {}\n@Injectable()\nexport class InvoiceService {}\nexport class Plain {}",
    )
    const app = results.find((r) => r.id.endsWith("#AppModule"))
    const service = results.find((r) => r.id.endsWith("#InvoiceService"))
    const plain = results.find((r) => r.id.endsWith("#Plain"))
    expect(app?.classification?.extKind).toBe("framework:nestjs:module")
    expect(service?.classification?.extKind).toBe("framework:nestjs:provider")
    expect(plain?.classification).toBeNull()
  })

  it("flags Guard-wrapped internal methods as boundaries without assigning the route extKind", async () => {
    const results = await classifyEach(
      "@Injectable()\nexport class Guarded {\n  @UseGuards(RolesGuard)\n  internal() {}\n}",
    )
    const method = results.find((r) => r.id.endsWith("#Guarded.internal"))
    expect(method?.classification?.decoratorBoundaries).toEqual({ UseGuards: true })
    expect(method?.classification?.extKind).toBeUndefined()
  })

  it.each([
    "Get",
    "Post",
    "Put",
    "Delete",
    "Patch",
    "Options",
    "Head",
    "All",
  ])("classifies all eight HTTP verbs (%s) through the real parser", async (verb) => {
    const results = await classifyEach(
      `@Controller('/x')\nexport class C {\n  @${verb}('/y')\n  handle() {}\n}`,
    )
    const method = results.find((r) => r.id.endsWith("#C.handle"))
    expect(method?.classification?.extKind).toBe("framework:nestjs:route")
    expect(method?.classification?.decoratorBoundaries?.[verb]).toBe(true)
  })

  it.each([
    "MessagePattern",
    "EventPattern",
    "SubscribeMessage",
  ])("classifies pattern handler %s as a route boundary", async (pattern) => {
    const results = await classifyEach(`export class H {\n  @${pattern}('/y')\n  handle() {}\n}`)
    const method = results.find((r) => r.id.endsWith("#H.handle"))
    expect(method?.classification?.extKind).toBe("framework:nestjs:route")
    expect(method?.classification?.decoratorBoundaries?.[pattern]).toBe(true)
  })

  it("classifies @Catch as framework:nestjs:filter", async () => {
    const results = await classifyEach("@Catch(HttpException)\nexport class ExceptionFilter {}")
    const cls = results.find((r) => r.id.endsWith("#ExceptionFilter"))
    expect(cls?.classification?.extKind).toBe("framework:nestjs:filter")
    expect(cls?.classification?.decoratorBoundaries).toEqual({ Catch: true })
    expect(cls?.classification?.derivedBy).toBe("framework:nestjs:filter")
  })

  it("hybrid class with both @Controller and @Injectable flags both boundaries", async () => {
    const results = await classifyEach("@Controller('/x')\n@Injectable()\nexport class Hybrid {}")
    const cls = results.find((r) => r.id.endsWith("#Hybrid"))
    // Source-order winner is Controller (line 1), so extKind takes controller
    // and both boundaries flip.
    expect(cls?.classification?.extKind).toBe("framework:nestjs:controller")
    expect(cls?.classification?.decoratorBoundaries).toEqual({
      Controller: true,
      Injectable: true,
    })
  })
})

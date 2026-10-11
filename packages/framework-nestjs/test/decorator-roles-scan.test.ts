import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import { beforeEach, describe, expect, it } from "vitest"
import { nestjsFrameworkPlugin } from "../src/index"

const workspace = useScratchWorkspace("decorator-roles")

const scanWorkspace = () =>
  scanWith(workspace.root, {
    languages: [langTypescriptPlugin],
    frameworks: [nestjsFrameworkPlugin],
  })

describe("scan — NestJS classes and their members", () => {
  beforeEach(async () => {
    await workspace.writeSource(
      "src/invoices.ts",
      [
        `import { Catch, Controller, Injectable, Module, Post, UseGuards } from "@nestjs/common"`,
        `import { MessagePattern } from "@nestjs/microservices"`,
        ``,
        `@Module({})`,
        `export class AppModule {}`,
        ``,
        `@Injectable()`,
        `export class InvoiceService {`,
        `  @UseGuards(RolesGuard)`,
        `  internal() { return 1 }`,
        `}`,
        ``,
        `@Controller("/invoices")`,
        `export class InvoiceController {`,
        `  @Post("/x")`,
        `  create() { return 1 }`,
        `}`,
        ``,
        `export class InvoiceEvents {`,
        `  @MessagePattern("invoice.created")`,
        `  handle() { return 1 }`,
        `}`,
        ``,
        `@Catch(HttpException)`,
        `export class InvoiceFilter {}`,
        ``,
        `@Controller("/hybrid")`,
        `@Injectable()`,
        `export class Hybrid {}`,
        ``,
        `export class Plain {}`,
        ``,
      ].join("\n"),
    )
  })

  it("gives each decorated class the role of its first NestJS decorator, flagging every one", async () => {
    const result = await scanWorkspace()
    const roleOf = (name: string) => {
      const symbol = symbolNamed(result, name)
      return [
        symbol.extKind,
        symbol.derivedBy.filter((tag) => tag.startsWith("framework:nestjs:")),
        symbol.decorators.map((d) => [d.name, d.boundary]),
      ]
    }

    expect(roleOf("AppModule")).toEqual([
      "framework:nestjs:module",
      ["framework:nestjs:module"],
      [["Module", true]],
    ])
    expect(roleOf("InvoiceService")).toEqual([
      "framework:nestjs:provider",
      ["framework:nestjs:provider"],
      [["Injectable", true]],
    ])
    expect(roleOf("InvoiceController")).toEqual([
      "framework:nestjs:controller",
      ["framework:nestjs:controller"],
      [["Controller", true]],
    ])
    expect(roleOf("InvoiceFilter")).toEqual([
      "framework:nestjs:filter",
      ["framework:nestjs:filter"],
      [["Catch", true]],
    ])
    expect(roleOf("Hybrid")).toEqual([
      "framework:nestjs:controller",
      ["framework:nestjs:controller"],
      [
        ["Controller", true],
        ["Injectable", true],
      ],
    ])
    expect(roleOf("Plain")).toEqual([null, [], []])
  })

  it("makes a method decorated with a verb or a pattern a route, and flags the decorator", async () => {
    const result = await scanWorkspace()

    for (const [name, decorator, tag] of [
      ["InvoiceController.create", "Post", "framework:nestjs:route:Post"],
      ["InvoiceEvents.handle", "MessagePattern", "framework:nestjs:route:MessagePattern"],
    ] as const) {
      const route = symbolNamed(result, name)
      expect(route.extKind).toBe("framework:nestjs:route")
      expect(route.derivedBy).toContain(tag)
      expect(route.decorators.map((d) => [d.name, d.boundary])).toEqual([[decorator, true]])
    }
  })

  it("flags a guard on a method as a boundary without making the method a route", async () => {
    const result = await scanWorkspace()
    const internal = symbolNamed(result, "InvoiceService.internal")

    expect(internal.extKind).toBeNull()
    expect(internal.derivedBy).toContain("framework:nestjs:handler:UseGuards")
    expect(internal.decorators.map((d) => [d.name, d.boundary])).toEqual([["UseGuards", true]])
  })
})

describe("scan — a decorator re-exported from @nestjs/* beside a foreign import", () => {
  it("trusts the re-export edge over the binding the file uses", async () => {
    await workspace.writeSource(
      "src/c.ts",
      [
        `import { Controller } from "routing-controllers"`,
        `export { Controller } from "@nestjs/common"`,
        ``,
        `@Controller("/x")`,
        `export class C {}`,
        ``,
      ].join("\n"),
    )

    const result = await scanWorkspace()
    const controller = symbolNamed(result, "C")

    expect(controller.extKind).toBe("framework:nestjs:controller")
    expect(controller.confidence).toBe("high")
  })
})

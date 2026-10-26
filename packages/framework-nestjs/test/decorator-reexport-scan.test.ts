import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { nestjsFrameworkPlugin } from "../src/index"

const workspace = useScratchWorkspace("decorator-reexport")

const LIBRARIES: Readonly<Record<string, string>> = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      paths: { "@app/common": ["libs/common/src/index.ts"], "@app/*": ["libs/*/src"] },
    },
  }),
  "libs/common/src/index.ts": `export { Controller, Get, Injectable } from "@nestjs/common"\n`,
  "libs/layered/src/index.ts": `export { Controller } from "./nest"\n`,
  "libs/layered/src/nest.ts": `export { Controller } from "@nestjs/common"\n`,
  "libs/foreign/src/index.ts": `export { Controller } from "routing-controllers"\n`,
  "libs/star/src/index.ts": `export * from "@nestjs/common"\n`,
  "libs/own/src/index.ts": `export function Controller(path: string) { return (target: object) => target }\n`,
  "src/common.ts": `export { Controller } from "@nestjs/common"\n`,
}

describe("scan — a NestJS decorator re-exported through a workspace barrel", () => {
  it.each([
    [
      "a path alias to a barrel re-exporting @nestjs/common",
      `import { Controller } from "@app/common"`,
      "Controller",
      "high",
    ],
    [
      "the same barrel, the decorator renamed on import",
      `import { Controller as Ctrl } from "@app/common"`,
      "Ctrl",
      "high",
    ],
    [
      "the same barrel through a namespace import",
      `import * as common from "@app/common"`,
      "common.Controller",
      "high",
    ],
    [
      "a wildcard alias to a barrel two re-exports deep",
      `import { Controller } from "@app/layered"`,
      "Controller",
      "high",
    ],
    ["a relative barrel", `import { Controller } from "./common"`, "Controller", "high"],
    [
      "a barrel re-exporting a competing library",
      `import { Controller } from "@app/foreign"`,
      "Controller",
      "medium",
    ],
    [
      "a barrel reaching @nestjs/common only through export *",
      `import { Controller } from "@app/star"`,
      "Controller",
      "medium",
    ],
    [
      "a barrel declaring its own decorator",
      `import { Controller } from "@app/own"`,
      "Controller",
      "medium",
    ],
    [
      "an alias to no file in the workspace",
      `import { Controller } from "@app/missing"`,
      "Controller",
      "medium",
    ],
  ])("rates a controller imported from %s", async (_case, importLine, written, confidence) => {
    for (const [path, source] of Object.entries(LIBRARIES))
      await workspace.writeSource(path, source)
    await workspace.writeSource(
      "src/x.controller.ts",
      `${importLine}\n\n@${written}("/x")\nexport class XController {}\n`,
    )

    const result = await scanWith(workspace.root, {
      languages: [langTypescriptPlugin],
      frameworks: [nestjsFrameworkPlugin],
    })

    const controller = symbolNamed(result, "XController")
    expect([controller.extKind, controller.confidence]).toEqual([
      "framework:nestjs:controller",
      confidence,
    ])
  })

  it("rates a route decorator re-exported through the barrel alongside its controller", async () => {
    for (const [path, source] of Object.entries(LIBRARIES))
      await workspace.writeSource(path, source)
    await workspace.writeSource(
      "src/y.controller.ts",
      [
        `import { Controller, Get } from "@app/common"`,
        ``,
        `@Controller("/y")`,
        `export class YController {`,
        `  @Get("/list")`,
        `  list() { return [] }`,
        `}`,
        ``,
      ].join("\n"),
    )

    const result = await scanWith(workspace.root, {
      languages: [langTypescriptPlugin],
      frameworks: [nestjsFrameworkPlugin],
    })

    const route = symbolNamed(result, "YController.list")
    expect([route.extKind, route.confidence]).toEqual(["framework:nestjs:route", "high"])
  })
})

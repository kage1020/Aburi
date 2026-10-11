import { decorator, makeCandidate, noopRegistry, silentLogger } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import {
  classifyNestjsSymbol,
  frameworkNestjsManifest,
  NestjsFrameworkPlugin,
  nestjsFrameworkPlugin,
} from "../src/index"
import { makeCtx } from "./fixtures/symbol"

describe("NestjsFrameworkPlugin", () => {
  it("exposes the frameworkNestjsManifest constant, from the class and the singleton alike", () => {
    expect(nestjsFrameworkPlugin.manifest).toBe(frameworkNestjsManifest)
    expect(new NestjsFrameworkPlugin().manifest).toBe(frameworkNestjsManifest)
  })

  it("init resolves without touching plugin state", async () => {
    await expect(
      new NestjsFrameworkPlugin().init({
        registry: noopRegistry,
        config: {},
        workspaceRoot: "/tmp",
        log: silentLogger,
      }),
    ).resolves.toBeUndefined()
  })

  it("dispatches classifySymbol to classifyNestjsSymbol, from the class and the singleton alike", () => {
    const candidate = makeCandidate({
      kind: "class",
      name: "MyController",
      decorators: [decorator({ name: "Controller" })],
    })
    const expected = classifyNestjsSymbol(candidate, makeCtx())

    expect(expected?.extKind).toBe("framework:nestjs:controller")
    expect(nestjsFrameworkPlugin.classifySymbol(candidate, makeCtx())).toEqual(expected)
    expect(new NestjsFrameworkPlugin().classifySymbol(candidate, makeCtx())).toEqual(expected)
  })
})

import { noopRegistry, silentLogger } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import {
  classifyReactSymbol,
  frameworkReactManifest,
  ReactFrameworkPlugin,
  reactFrameworkPlugin,
} from "../src/index"
import { makeCandidate, makeCtx } from "./fixtures/symbol"

describe("ReactFrameworkPlugin", () => {
  it("exposes the frameworkReactManifest constant, from the class and the singleton alike", () => {
    expect(reactFrameworkPlugin.manifest).toBe(frameworkReactManifest)
    expect(new ReactFrameworkPlugin().manifest).toBe(frameworkReactManifest)
  })

  it("init resolves without touching plugin state", async () => {
    await expect(
      new ReactFrameworkPlugin().init({
        registry: noopRegistry,
        config: {},
        workspaceRoot: "/tmp",
        log: silentLogger,
      }),
    ).resolves.toBeUndefined()
  })

  it("dispatches classifySymbol to classifyReactSymbol, from the class and the singleton alike", () => {
    const candidate = makeCandidate({ kind: "function", name: "useThing" })
    const expected = classifyReactSymbol(candidate, makeCtx())

    expect(expected?.extKind).toBe("framework:react:hook")
    expect(reactFrameworkPlugin.classifySymbol(candidate, makeCtx())).toEqual(expected)
    expect(new ReactFrameworkPlugin().classifySymbol(candidate, makeCtx())).toEqual(expected)
  })
})

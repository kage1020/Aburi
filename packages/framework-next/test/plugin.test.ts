import { noopRegistry, silentLogger } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import {
  classifyNextSymbol,
  frameworkNextManifest,
  NextFrameworkPlugin,
  nextFrameworkPlugin,
} from "../src/index"
import { makeCtx, symbolIn } from "./fixtures/symbol"

describe("NextFrameworkPlugin", () => {
  it("exposes the frameworkNextManifest constant, from the class and the singleton alike", () => {
    expect(nextFrameworkPlugin.manifest).toBe(frameworkNextManifest)
    expect(new NextFrameworkPlugin().manifest).toBe(frameworkNextManifest)
  })

  it("init resolves without touching plugin state", async () => {
    await expect(
      new NextFrameworkPlugin().init({
        registry: noopRegistry,
        config: {},
        workspaceRoot: "/tmp",
        log: silentLogger,
      }),
    ).resolves.toBeUndefined()
  })

  it("dispatches classifySymbol to classifyNextSymbol, from the class and the singleton alike", () => {
    const file = "app/dashboard/page.tsx"
    const candidate = symbolIn(file, "Page", { exportDefault: true })
    const expected = classifyNextSymbol(candidate, makeCtx(file))

    expect(expected?.extKind).toBe("framework:next:page")
    expect(nextFrameworkPlugin.classifySymbol(candidate, makeCtx(file))).toEqual(expected)
    expect(new NextFrameworkPlugin().classifySymbol(candidate, makeCtx(file))).toEqual(expected)
  })
})

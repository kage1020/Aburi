import { noopRegistry, silentLogger } from "@aburi/test-support"
import type { PluginContext } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { expressFrameworkPlugin, frameworkExpressManifest } from "../src/index"

const pluginContext: PluginContext = {
  registry: noopRegistry,
  config: {},
  workspaceRoot: "/tmp",
  log: silentLogger,
}

describe("expressFrameworkPlugin", () => {
  it("exposes the framework-express manifest identity", () => {
    expect(expressFrameworkPlugin.manifest).toBe(frameworkExpressManifest)
  })

  it("init() resolves and is idempotent across multiple calls", async () => {
    await expect(expressFrameworkPlugin.init(pluginContext)).resolves.toBeUndefined()
    await expect(expressFrameworkPlugin.init(pluginContext)).resolves.toBeUndefined()
  })
})

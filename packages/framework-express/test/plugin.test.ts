import type { PluginContext, VocabRegistry } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { expressFrameworkPlugin, frameworkExpressManifest } from "../src/index"

const noopRegistry: VocabRegistry = {
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
}

const pluginContext: PluginContext = {
  registry: noopRegistry,
  config: {},
  workspaceRoot: "/tmp",
  log: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
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

import { errorFrom } from "@aburi/test-support"
import type { PluginManifest } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { RegistryError, VocabRegistry } from "../src/index"
import { effectsManifest, frameworkManifest, langManifest } from "./fixtures/manifests"

const controller = { baseKind: "class", description: "x" } as const

describe("a manifest declaring a reserved namespace", () => {
  it.each<[string, PluginManifest, string]>([
    [
      "an effect id under core",
      effectsManifest({ provides: { effects: [{ id: "core:read", description: "x" }] } }),
      "core:read",
    ],
    [
      "an effect prefix under aburi",
      effectsManifest({ provides: { effectPrefixes: ["aburi:x"] } }),
      "aburi:x",
    ],
    [
      "an extKind id under core",
      frameworkManifest({ provides: { extKinds: [{ id: "core:foo", ...controller }] } }),
      "core:foo",
    ],
    [
      "framework:hint itself as an extKind prefix",
      frameworkManifest({ provides: { extKindPrefixes: ["framework:hint"] } }),
      "framework:hint",
    ],
    [
      "an extKind prefix under framework:hint",
      frameworkManifest({ provides: { extKindPrefixes: ["framework:hint:acme"] } }),
      "framework:hint:acme",
    ],
    ["a framework name under _", frameworkManifest({ provides: { frameworks: ["_:fw"] } }), "_:fw"],
    [
      "a derivedBy prefix under aburi",
      langManifest({ provides: { derivedByPrefixes: ["aburi:meta"] } }),
      "aburi:meta",
    ],
    ["the bare root _", langManifest({ provides: { derivedByPrefixes: ["_"] } }), "_"],
  ])("refuses %s", async (_, manifest, value) => {
    const err = await errorFrom(RegistryError, () => new VocabRegistry().register(manifest))
    expect(err).toMatchObject({ code: "reserved-namespace", value, plugins: [manifest.name] })
  })

  it("names the value and every reserved root", async () => {
    const m = langManifest({ provides: { derivedByPrefixes: ["aburi:meta"] } })
    expect((await errorFrom(RegistryError, () => new VocabRegistry().register(m))).message).toBe(
      'Plugin "lang-foo" declares derivedBy prefix "aburi:meta" inside a reserved namespace ' +
        "(core / aburi / _ / framework:hint).",
    )
  })

  it("reads framework:hintsomething as outside framework:hint, at the segment boundary", () => {
    const reg = new VocabRegistry()
    reg.register(frameworkManifest({ provides: { extKindPrefixes: ["framework:hintsomething"] } }))
    expect(reg.findExtKind("framework:hintsomething:x")?.owner.name).toBe("framework-foo")
  })

  it("refuses the reserved namespace before the plugin type's own namespaces", async () => {
    const m = langManifest({ provides: { frameworks: ["core:x"] } })
    expect((await errorFrom(RegistryError, () => new VocabRegistry().register(m))).code).toBe(
      "reserved-namespace",
    )
  })
})

describe("registerHint", () => {
  const hint = (name: string, prefix: string) =>
    frameworkManifest({ name, provides: { extKindPrefixes: [prefix] } })

  it("lets a frameworkHints manifest hold a namespace under framework:hint", () => {
    const reg = new VocabRegistry()
    reg.registerHint(hint("hint-acme", "framework:hint:acme"))
    expect(reg.findExtKind("framework:hint:acme:controller")?.owner.name).toBe("hint-acme")
  })

  it.each([
    ["framework:hint itself", hint("hint-bare", "framework:hint")],
    [
      "another reserved root",
      frameworkManifest({ name: "hint-core", provides: { derivedByPrefixes: ["core:x"] } }),
    ],
  ])("still refuses %s", async (_, manifest) => {
    expect(
      (await errorFrom(RegistryError, () => new VocabRegistry().registerHint(manifest))).code,
    ).toBe("reserved-namespace")
  })

  it("refuses two frameworkHints manifests the same namespace under framework:hint", async () => {
    const reg = new VocabRegistry()
    reg.registerHint(hint("hint-a", "framework:hint:acme"))
    const err = await errorFrom(RegistryError, () =>
      reg.registerHint(hint("hint-b", "framework:hint:acme")),
    )
    expect(err).toMatchObject({ code: "duplicate-prefix", plugins: ["hint-a", "hint-b"] })
  })
})

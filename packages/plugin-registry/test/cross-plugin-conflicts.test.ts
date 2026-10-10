import { errorFrom } from "@aburi/test-support"
import type { PluginManifest } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { RegistryError, VocabRegistry } from "../src/index"
import { effectsManifest, frameworkManifest } from "./fixtures/manifests"

const controller = { baseKind: "class", description: "x" } as const

describe("a manifest that claims what another plugin already owns", () => {
  it.each<[string, PluginManifest, PluginManifest, string, string, string]>([
    [
      "an effect id",
      effectsManifest({
        name: "effects-a",
        provides: { effects: [{ id: "x-a:write", description: "x" }] },
      }),
      effectsManifest({
        name: "effects-b",
        xPrefix: "a",
        provides: { effects: [{ id: "x-a:write", description: "y" }] },
      }),
      "duplicate-id",
      "x-a:write",
      'Effect id "x-a:write" is already declared by plugin "effects-a".',
    ],
    [
      "an extKind id",
      frameworkManifest({
        name: "framework-a",
        provides: { extKinds: [{ id: "framework:a:controller", ...controller }] },
      }),
      frameworkManifest({
        name: "framework-b",
        provides: { extKinds: [{ id: "framework:a:controller", ...controller }] },
      }),
      "duplicate-id",
      "framework:a:controller",
      'extKind id "framework:a:controller" is already declared by plugin "framework-a".',
    ],
    [
      "a framework name",
      frameworkManifest({ name: "framework-a", provides: { frameworks: ["nestjs"] } }),
      frameworkManifest({ name: "framework-b", provides: { frameworks: ["nestjs"] } }),
      "duplicate-id",
      "nestjs",
      'Framework "nestjs" is already declared by plugin "framework-a".',
    ],
    [
      "an effect prefix",
      effectsManifest({ name: "effects-acme", provides: { effectPrefixes: ["x-acme"] } }),
      effectsManifest({
        name: "effects-acme2",
        xPrefix: "acme",
        provides: { effectPrefixes: ["x-acme"] },
      }),
      "duplicate-prefix",
      "x-acme",
      'Effect prefix "x-acme" is already declared by plugin "effects-acme".',
    ],
    [
      "an extKind prefix",
      frameworkManifest({ name: "framework-a", provides: { extKindPrefixes: ["framework:acme"] } }),
      frameworkManifest({ name: "framework-b", provides: { extKindPrefixes: ["framework:acme"] } }),
      "duplicate-prefix",
      "framework:acme",
      'extKind prefix "framework:acme" is already declared by plugin "framework-a".',
    ],
    [
      "a derivedBy prefix",
      frameworkManifest({
        name: "framework-a",
        provides: { derivedByPrefixes: ["framework:nest"] },
      }),
      frameworkManifest({
        name: "framework-b",
        provides: { derivedByPrefixes: ["framework:nest"] },
      }),
      "duplicate-prefix",
      "framework:nest",
      'derivedBy prefix "framework:nest" is already declared by plugin "framework-a".',
    ],
    [
      "an effect id under an effect prefix",
      effectsManifest({ name: "effects-acme", provides: { effectPrefixes: ["x-acme"] } }),
      effectsManifest({
        name: "effects-other",
        xPrefix: "acme",
        provides: { effects: [{ id: "x-acme:charge", description: "x" }] },
      }),
      "prefix-shadow-id",
      "x-acme:charge",
      'Effect id "x-acme:charge" from plugin "effects-other" is shadowed by existing prefix ' +
        '"x-acme" owned by plugin "effects-acme".',
    ],
    [
      "an extKind id under an extKind prefix",
      frameworkManifest({ name: "framework-a", provides: { extKindPrefixes: ["framework:acme"] } }),
      frameworkManifest({
        name: "framework-b",
        provides: { extKinds: [{ id: "framework:acme:job", ...controller }] },
      }),
      "prefix-shadow-id",
      "framework:acme:job",
      'extKind id "framework:acme:job" from plugin "framework-b" is shadowed by existing prefix ' +
        '"framework:acme" owned by plugin "framework-a".',
    ],
    [
      "an effect prefix over an effect id",
      effectsManifest({
        name: "effects-a",
        xPrefix: "acme",
        provides: { effects: [{ id: "x-acme:charge", description: "x" }] },
      }),
      effectsManifest({
        name: "effects-b",
        xPrefix: "acme",
        provides: { effectPrefixes: ["x-acme"] },
      }),
      "prefix-shadow-id",
      "x-acme:charge",
      'New effect prefix "x-acme" from plugin "effects-b" would shadow existing effect id ' +
        '"x-acme:charge" owned by plugin "effects-a".',
    ],
    [
      "an extKind prefix over an extKind id",
      frameworkManifest({
        name: "framework-a",
        provides: { extKinds: [{ id: "framework:acme:job", ...controller }] },
      }),
      frameworkManifest({ name: "framework-b", provides: { extKindPrefixes: ["framework:acme"] } }),
      "prefix-shadow-id",
      "framework:acme:job",
      'New extKind prefix "framework:acme" from plugin "framework-b" would shadow existing ' +
        'extKind id "framework:acme:job" owned by plugin "framework-a".',
    ],
    [
      "an effect prefix nested under another",
      effectsManifest({
        name: "effects-a",
        xPrefix: "acme",
        provides: { effectPrefixes: ["x-acme"] },
      }),
      effectsManifest({
        name: "effects-b",
        xPrefix: "acme:sub",
        provides: { effectPrefixes: ["x-acme:sub"] },
      }),
      "prefix-prefix-overlap",
      "x-acme:sub",
      'Effect prefix "x-acme:sub" (plugin "effects-b") overlaps with existing prefix "x-acme" ' +
        '(plugin "effects-a").',
    ],
    [
      "an extKind prefix nested under another",
      frameworkManifest({ name: "framework-a", provides: { extKindPrefixes: ["framework:acme"] } }),
      frameworkManifest({
        name: "framework-b",
        provides: { extKindPrefixes: ["framework:acme:jobs"] },
      }),
      "prefix-prefix-overlap",
      "framework:acme:jobs",
      'extKind prefix "framework:acme:jobs" (plugin "framework-b") overlaps with existing prefix ' +
        '"framework:acme" (plugin "framework-a").',
    ],
    [
      "an extKind prefix enclosing another",
      frameworkManifest({
        name: "framework-a",
        provides: { extKindPrefixes: ["framework:acme:jobs"] },
      }),
      frameworkManifest({ name: "framework-b", provides: { extKindPrefixes: ["framework:acme"] } }),
      "prefix-prefix-overlap",
      "framework:acme",
      'extKind prefix "framework:acme" (plugin "framework-b") overlaps with existing prefix ' +
        '"framework:acme:jobs" (plugin "framework-a").',
    ],
    [
      "a derivedBy prefix nested under another",
      frameworkManifest({
        name: "framework-a",
        provides: { derivedByPrefixes: ["framework:acme"] },
      }),
      frameworkManifest({
        name: "framework-b",
        provides: { derivedByPrefixes: ["framework:acme:sub"] },
      }),
      "derivedby-prefix-overlap",
      "framework:acme:sub",
      'derivedBy prefix "framework:acme:sub" (plugin "framework-b") overlaps with existing prefix ' +
        '"framework:acme" (plugin "framework-a").',
    ],
    [
      "a derivedBy prefix enclosing another",
      frameworkManifest({
        name: "framework-a",
        provides: { derivedByPrefixes: ["framework:acme:sub"] },
      }),
      frameworkManifest({
        name: "framework-b",
        provides: { derivedByPrefixes: ["framework:acme"] },
      }),
      "derivedby-prefix-overlap",
      "framework:acme",
      'derivedBy prefix "framework:acme" (plugin "framework-b") overlaps with existing prefix ' +
        '"framework:acme:sub" (plugin "framework-a").',
    ],
  ])("refuses %s, naming the owner first and the newcomer second", async (_, existing, newcomer, code, value, message) => {
    const reg = new VocabRegistry()
    reg.register(existing)
    const err = await errorFrom(RegistryError, () => reg.register(newcomer))
    expect(err).toMatchObject({ code, value, plugins: [existing.name, newcomer.name] })
    expect(err.message).toBe(message)
  })

  it.each([
    ["extKind", "extKindPrefixes"],
    ["derivedBy", "derivedByPrefixes"],
  ] as const)("lets %s prefixes that only share a leading string coexist", (_, key) => {
    const reg = new VocabRegistry()
    reg.register(
      frameworkManifest({ name: "framework-a", provides: { [key]: ["framework:acme"] } }),
    )
    reg.register(
      frameworkManifest({ name: "framework-b", provides: { [key]: ["framework:acmegrid"] } }),
    )
    expect(reg.listPlugins().map((p) => p.name)).toEqual(["framework-a", "framework-b"])
  })

  it("leaves the registry untouched when a register fails", async () => {
    const reg = new VocabRegistry()
    const good = frameworkManifest({ name: "framework-good", provides: { frameworks: ["nestjs"] } })
    reg.register(good)
    const bad = frameworkManifest({
      name: "framework-bad",
      provides: {
        extKinds: [{ id: "framework:good:thing", ...controller }],
        frameworks: ["nestjs"],
      },
    })
    await errorFrom(RegistryError, () => reg.register(bad))
    expect(reg.findExtKind("framework:good:thing")).toBeNull()
    expect(reg.listPlugins()).toEqual([good])
  })
})

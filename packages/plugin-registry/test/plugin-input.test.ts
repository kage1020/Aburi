import { importEdge } from "@aburi/test-support"
import type { EffectsManifest, ImportEdge } from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  assertImportBinding,
  assertNamespaceBinding,
  assertNonEmptySegments,
  defineEffectsManifest,
  hasLiteralFirstArgument,
  hasMatchingImport,
  identifierMentions,
  identifierWords,
  matchesModuleOrSubpath,
  type PluginInputOrigin,
  receiverConfidence,
} from "../src/plugin-input"

const ORIGIN: PluginInputOrigin = { plugin: "effects-example", filePath: "src/service.ts" }

function edge(source: string, line: number): ImportEdge {
  return importEdge({ source, symbols: ["Thing"], line })
}

describe("assertNonEmptySegments", () => {
  it.each([
    ["prisma.user.create", ["prisma", "user", "create"], "create"],
    ["fetch", ["fetch"], "fetch"],
  ])("splits %s into its segments and its last one", (target, segments, last) => {
    expect(assertNonEmptySegments(target, ORIGIN)).toEqual({ segments, last })
  })

  it("types the first segment as present, so callers index it without a cast", () => {
    const first: string = assertNonEmptySegments("db.select", ORIGIN).segments[0]
    expect(first).toBe("db")
  })

  it("throws for an empty target, naming the plugin and the file", () => {
    expect(() => assertNonEmptySegments("", ORIGIN)).toThrow(
      "effects-example (src/service.ts): CallCandidate.target is empty — language plugin emitted an unnormalized callee",
    )
  })

  it.each([
    ["leading dot", ".create"],
    ["trailing dot", "prisma.user."],
    ["adjacent dots", "prisma..create"],
    ["a lone dot", "."],
  ])("throws for a target with %s", (_label, target) => {
    expect(() => assertNonEmptySegments(target, ORIGIN)).toThrow(
      `effects-example (src/service.ts): CallCandidate.target "${target}" has empty segment(s) — language plugin emitted an unnormalized callee`,
    )
  })

  it("reports the caller's own plugin name and file, not a hardcoded one", () => {
    const other: PluginInputOrigin = { plugin: "effects-other", filePath: "app/routes/x.tsx" }
    expect(() => assertNonEmptySegments("", other)).toThrow(
      /^effects-other \(app\/routes\/x\.tsx\)/,
    )
    expect(() => assertNonEmptySegments("a..b", other)).toThrow(
      /^effects-other \(app\/routes\/x\.tsx\)/,
    )
  })
})

describe("hasMatchingImport", () => {
  const isExample = (source: string) => source === "example-orm"

  it.each([
    ["some edge", [edge("react", 1), edge("example-orm", 2)], true],
    ["no edge", [edge("react", 1), edge("zod", 2)], false],
    ["an empty import list", [], false],
  ])("answers whether the predicate holds for %s", (_, imports, expected) => {
    expect(hasMatchingImport(imports, ORIGIN, isExample)).toBe(expected)
  })

  it("throws for an empty ImportEdge.source, naming the plugin, file, and line", () => {
    expect(() => hasMatchingImport([edge("", 7)], ORIGIN, isExample)).toThrow(
      "effects-example (src/service.ts, line 7): ImportEdge.source is empty — language plugin emitted an unnormalized import edge",
    )
  })

  it("validates every edge before matching, so a broken edge after a match still throws", () => {
    expect(() =>
      hasMatchingImport([edge("example-orm", 1), edge("", 2)], ORIGIN, isExample),
    ).toThrow(/line 2/)
  })

  it("reports the first broken edge when several are malformed", () => {
    expect(() => hasMatchingImport([edge("", 3), edge("", 9)], ORIGIN, isExample)).toThrow(/line 3/)
  })

  it("hands the predicate the module specifier only", () => {
    const seen: string[] = []
    hasMatchingImport([edge("react", 1), edge("example-orm", 2)], ORIGIN, (source) => {
      seen.push(source)
      return false
    })
    expect(seen).toEqual(["react", "example-orm"])
  })
})

describe("assertImportBinding", () => {
  const named = (symbols: string[], line = 1): ImportEdge =>
    importEdge({ source: "example-orm", symbols, line })

  it.each([
    ["an unaliased entry", { imported: "Thing", local: "Thing" }, "Thing"],
    ["an aliased entry", { imported: "Thing", local: "T" }, "Thing as T"],
  ])("accepts %s", (_, binding, raw) => {
    expect(() => assertImportBinding(binding, raw, named([raw]), ORIGIN)).not.toThrow()
  })

  it.each([
    ["exported half", { imported: "", local: "T" }, " as T"],
    ["local half", { imported: "Thing", local: "" }, "Thing as "],
    ["entry as a whole", { imported: "", local: "" }, ""],
  ])("rejects an entry whose %s is empty, naming the plugin, file and line", (_, binding, raw) => {
    expect(() => assertImportBinding(binding, raw, named([raw], 4), ORIGIN)).toThrow(
      `effects-example (src/service.ts, line 4): ImportEdge.symbols entry "${raw}" has an empty half — language plugin emitted an unnormalized import edge`,
    )
  })
})

describe("assertNamespaceBinding", () => {
  const namespaceEdge = importEdge({ source: "example-orm", symbols: "*", line: 3 })

  it("accepts a binding that names something", () => {
    expect(() => assertNamespaceBinding("orm", namespaceEdge, ORIGIN)).not.toThrow()
  })

  it("rejects an empty binding, naming the plugin, file and line", () => {
    expect(() => assertNamespaceBinding("", namespaceEdge, ORIGIN)).toThrow(
      "effects-example (src/service.ts, line 3): ImportEdge.namespaceBinding is empty — language plugin emitted an unnormalized import edge",
    )
  })
})

describe("identifierWords", () => {
  it("splits a camelCase identifier into lowercase words", () => {
    expect(identifierWords("prismaClient")).toEqual(["prisma", "client"])
    expect(identifierWords("readReplicaDb")).toEqual(["read", "replica", "db"])
  })

  it("splits on separators — underscores, dollars, dashes", () => {
    expect(identifierWords("_prisma")).toEqual(["prisma"])
    expect(identifierWords("read_replica_db")).toEqual(["read", "replica", "db"])
    expect(identifierWords("$db")).toEqual(["db"])
    expect(identifierWords("read-replica")).toEqual(["read", "replica"])
  })

  it("keeps an acronym run whole", () => {
    expect(identifierWords("DBClient")).toEqual(["db", "client"])
    expect(identifierWords("HTTPClient")).toEqual(["http", "client"])
    expect(identifierWords("DB")).toEqual(["db"])
  })

  it("treats digits as boundaries rather than words", () => {
    expect(identifierWords("db2")).toEqual(["db"])
    expect(identifierWords("v2Client")).toEqual(["v", "client"])
  })

  it("returns an empty list for a name with no letters", () => {
    expect(identifierWords("")).toEqual([])
    expect(identifierWords("__")).toEqual([])
    expect(identifierWords("42")).toEqual([])
  })

  it("is a word split, not a substring search — the distinction the callers rely on", () => {
    expect(identifierWords("feedback")).toEqual(["feedback"])
    expect(identifierWords("context")).toEqual(["context"])
  })
})

describe("identifierMentions", () => {
  const vocabulary: ReadonlySet<string> = new Set(["db", "prisma", "tx"])

  it("is true when any word of the name is in the vocabulary", () => {
    expect(identifierMentions("db", vocabulary)).toBe(true)
    expect(identifierMentions("prismaClient", vocabulary)).toBe(true)
    expect(identifierMentions("readReplicaDb", vocabulary)).toBe(true)
    expect(identifierMentions("_tx", vocabulary)).toBe(true)
  })

  it("is false when no word is in the vocabulary", () => {
    expect(identifierMentions("router", vocabulary)).toBe(false)
    expect(identifierMentions("cache", vocabulary)).toBe(false)
    expect(identifierMentions("feedback", vocabulary)).toBe(false)
    expect(identifierMentions("context", vocabulary)).toBe(false)
    expect(identifierMentions("", vocabulary)).toBe(false)
  })
})

describe("hasLiteralFirstArgument", () => {
  it("is true when the first argument was a literal", () => {
    expect(hasLiteralFirstArgument({ literalArgs: ["/users/:id", null] })).toBe(true)
    expect(hasLiteralFirstArgument({ literalArgs: ["42"] })).toBe(true)
  })

  it("is false when the first argument was not a literal", () => {
    expect(hasLiteralFirstArgument({ literalArgs: [null, "second"] })).toBe(false)
  })

  it("is false for a call with no arguments", () => {
    // Nothing to be a literal. Arity is a separate question, decided by the caller.
    expect(hasLiteralFirstArgument({ literalArgs: [] })).toBe(false)
  })
})

describe("matchesModuleOrSubpath", () => {
  const isDrizzle = matchesModuleOrSubpath("drizzle-orm")

  it.each([
    "drizzle-orm",
    "drizzle-orm/postgres-js",
    "drizzle-orm/aws-data-api/pg",
  ])("accepts the root or any subpath: %s", (source) => {
    expect(isDrizzle(source)).toBe(true)
  })

  it.each([
    "drizzle",
    "drizzle-orm-mock",
    "not-drizzle-orm",
    "@drizzle/kit",
  ])("rejects the lookalike %s — the `/` is the boundary", (source) => {
    expect(isDrizzle(source)).toBe(false)
  })

  it("accepts any of several roots", () => {
    const isTrpcClient = matchesModuleOrSubpath("@trpc/client", "@trpc/next")
    expect(isTrpcClient("@trpc/next/app-dir/client")).toBe(true)
    expect(isTrpcClient("@trpc/server")).toBe(false)
  })
})

describe("receiverConfidence", () => {
  const namesDb = (segment: string) => segment === "db"
  const oneArg = { argumentCount: 1 }
  const twoArgs = { argumentCount: 2 }
  const dynamic = { argumentCount: 1, dynamicReceiver: true }

  it("is high only when the receiver is named, static, and within arity", () => {
    expect(receiverConfidence("db", oneArg, 1, namesDb)).toBe("high")
  })

  it.each([
    ["an unrecognized receiver", "store", oneArg, 1],
    ["a missing receiver", undefined, oneArg, 1],
    ["a dynamic receiver", "db", dynamic, 1],
    ["an over-long argument list", "db", twoArgs, 1],
  ])("is medium for %s", (_label, segment, call, max) => {
    expect(receiverConfidence(segment, call, max, namesDb)).toBe("medium")
  })

  it("reads the arity limit off the terminal the caller passes", () => {
    expect(receiverConfidence("db", twoArgs, 2, namesDb)).toBe("high")
  })
})

describe("defineEffectsManifest", () => {
  it("builds the shared effects-plugin manifest around the two chosen literals", () => {
    const manifest = defineEffectsManifest("effects-foo", "effects-plugin:foo")
    expect(manifest).toEqual({
      $schema: "https://aburi.kage1020.com/schema/aburi.plugin.v1.json",
      name: "effects-foo",
      version: "0.0.0",
      type: "effects",
      engines: { aburi: "*" },
      provides: {
        effects: [],
        effectPrefixes: [],
        extKinds: [],
        extKindPrefixes: [],
        derivedByPrefixes: ["effects-plugin:foo"],
        frameworks: [],
      },
    })
    // Narrow literals survive, and the result is an `EffectsManifest` — both compile-time.
    const name: "effects-foo" = manifest.name
    const prefixes: ["effects-plugin:foo"] = manifest.provides.derivedByPrefixes
    const widened: EffectsManifest = manifest
    expect([name, prefixes, widened.type]).toEqual([
      "effects-foo",
      ["effects-plugin:foo"],
      "effects",
    ])
  })

  it("keeps xPrefix and capabilities off the shape, so reading either is a compile error", () => {
    const manifest = defineEffectsManifest("effects-foo", "effects-plugin:foo")
    // @ts-expect-error `xPrefix` is the registry's to derive, not the manifest's to declare.
    const xPrefix = manifest.xPrefix
    // @ts-expect-error a first-party effects plugin claims no capabilities.
    const capabilities = manifest.capabilities
    expect([xPrefix, capabilities]).toEqual([undefined, undefined])
  })
})

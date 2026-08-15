import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { ImportEdge } from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  assertImportBinding,
  assertNonEmptySegments,
  hasMatchingImport,
  type PluginInputOrigin,
} from "../src/plugin-input"

const ORIGIN: PluginInputOrigin = { plugin: "effects-example", filePath: "src/service.ts" }

function edge(source: string, line: number): ImportEdge {
  return { source, symbols: ["Thing"], line, dynamic: false }
}

describe("assertNonEmptySegments", () => {
  it("splits a well-formed target into its segments", () => {
    const result = assertNonEmptySegments("prisma.user.create", ORIGIN)
    expect(result.segments).toEqual(["prisma", "user", "create"])
    expect(result.last).toBe("create")
  })

  it("accepts a single-segment target", () => {
    const result = assertNonEmptySegments("fetch", ORIGIN)
    expect(result.segments).toEqual(["fetch"])
    expect(result.last).toBe("fetch")
  })

  it("types the first segment as present, so callers index it without a cast", () => {
    // The tuple type is the whole point of the return value: a `readonly string[]` would
    // widen `segments[0]` to `string | undefined` under noUncheckedIndexedAccess and push
    // a cast back into every classifier. This assignment is the compile-time assertion.
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

  it("returns true when any edge satisfies the predicate", () => {
    expect(hasMatchingImport([edge("react", 1), edge("example-orm", 2)], ORIGIN, isExample)).toBe(
      true,
    )
  })

  it("returns false when no edge satisfies the predicate", () => {
    expect(hasMatchingImport([edge("react", 1), edge("zod", 2)], ORIGIN, isExample)).toBe(false)
  })

  it("returns false for an empty import list without throwing", () => {
    expect(hasMatchingImport([], ORIGIN, isExample)).toBe(false)
  })

  it("throws for an empty ImportEdge.source, naming the plugin, file, and line", () => {
    expect(() => hasMatchingImport([edge("", 7)], ORIGIN, isExample)).toThrow(
      "effects-example (src/service.ts, line 7): ImportEdge.source is empty — language plugin emitted an unnormalized import edge",
    )
  })

  it("validates every edge before matching, so a broken edge after a match still throws", () => {
    // A `.some()` that validated inline would short-circuit on the match at index 0 and
    // never see the broken edge behind it, making throw behaviour depend on import order.
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
  const named = (symbols: string[], line = 1): ImportEdge => ({
    source: "example-orm",
    symbols,
    line,
    dynamic: false,
  })

  it("accepts an unaliased entry", () => {
    expect(() =>
      assertImportBinding({ imported: "Thing", local: "Thing" }, "Thing", named(["Thing"]), ORIGIN),
    ).not.toThrow()
  })

  it("accepts an aliased entry", () => {
    expect(() =>
      assertImportBinding(
        { imported: "Thing", local: "T" },
        "Thing as T",
        named(["Thing as T"]),
        ORIGIN,
      ),
    ).not.toThrow()
  })

  it("rejects an entry whose exported half is empty", () => {
    // `" as T"`. The local half survives, so a caller that only guards `local` indexes the
    // name against an empty canonical — which matches no vocabulary table and drops the
    // classification with nothing recording that anything was skipped.
    expect(() =>
      assertImportBinding({ imported: "", local: "T" }, " as T", named([" as T"], 4), ORIGIN),
    ).toThrow(
      /effects-example \(src\/service\.ts, line 4\).*ImportEdge\.symbols entry " as T" has an empty half/,
    )
  })

  it("rejects an entry whose local half is empty", () => {
    expect(() =>
      assertImportBinding(
        { imported: "Thing", local: "" },
        "Thing as ",
        named(["Thing as "], 6),
        ORIGIN,
      ),
    ).toThrow(/line 6.*"Thing as " has an empty half/)
  })

  it("rejects an entry that is empty outright", () => {
    expect(() =>
      assertImportBinding({ imported: "", local: "" }, "", named([""], 2), ORIGIN),
    ).toThrow(/line 2.*"" has an empty half/)
  })
})

describe("plugin-input module", () => {
  it("has no value imports, so the subpath stays free of the barrel's ajv setup", () => {
    // The whole reason this module is a separate tsdown entry is that importing the
    // package root evaluates `manifest.ts`, which compiles the plugin JSON Schema at
    // module scope. A value import added here would fold this chunk back into that graph
    // — silently, since nothing else in the build would fail. Asserted against the source
    // rather than `dist/` so the check does not depend on a build having run.
    const source = readFileSync(
      fileURLToPath(new URL("../src/plugin-input.ts", import.meta.url)),
      "utf8",
    )
    const importLines = source.split("\n").filter((line) => line.startsWith("import "))
    expect(importLines).toEqual(['import type { ImportEdge } from "@aburi/types"'])
  })
})

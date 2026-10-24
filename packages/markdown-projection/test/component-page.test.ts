import { component, dependency, makeSymbol, zeroFp } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { droppedFoldout, ProjectionInvariantError } from "../src"
import { componentPage, droppedSymbol } from "./fixtures"
import { sectionOf } from "./markdown"

describe("projectComponent — header", () => {
  it("names the component and counts kept and dropped Symbols", () => {
    const md = componentPage(
      [
        makeSymbol({ id: "ts:src/a.ts#f", name: "f" }),
        droppedSymbol("ts:src/dto.ts#Dto", "DTO shape"),
      ],
      {
        of: component({
          id: "billing",
          name: "Billing",
          roots: ["apps/billing", "packages/billing-domain"],
          frameworks: ["nestjs"],
        }),
      },
    )
    expect(md.split("\n").slice(0, 8)).toEqual([
      "# Component: billing",
      "",
      "**Name**: `Billing`",
      "**Roots**: `apps/billing`, `packages/billing-domain`",
      "**Languages**: ts",
      "**Frameworks**: nestjs",
      "**Symbols**: 1 kept · 1 dropped",
      "",
    ])
  })

  it("leaves out the Frameworks row when there are none", () => {
    expect(componentPage([])).not.toContain("**Frameworks**")
  })

  it("lists the public API when the component declares one", () => {
    const md = componentPage([], {
      of: component({ id: "billing", name: "Billing", publicApi: ["src/index.ts"] }),
    })
    expect(sectionOf(md, "## Public API")).toEqual(["## Public API", "", "- `src/index.ts`", ""])
    expect(componentPage([])).not.toContain("## Public API")
  })
})

describe("projectComponent — Symbols", () => {
  it("groups Symbols by file in path order, each file's by line and then id", () => {
    const at = (file: string, name: string, startLine: number) => {
      const symbol = makeSymbol({ id: `ts:${file}#${name}`, name, fingerprint: zeroFp() })
      return { ...symbol, source: { ...symbol.source, startLine } }
    }
    const md = componentPage([
      at("src/b.ts", "late", 9),
      at("src/b.ts", "second", 2),
      at("src/b.ts", "first", 2),
      at("src/a.ts", "only", 5),
      at("src/B.ts", "upper", 1),
    ])
    expect(
      md.split("\n").filter((line) => line.startsWith("### ") || line.startsWith("#### ")),
    ).toEqual([
      "### `src/B.ts`",
      "#### `upper` *(function)*",
      "### `src/a.ts`",
      "#### `only` *(function)*",
      "### `src/b.ts`",
      "#### `first` *(function)*",
      "#### `second` *(function)*",
      "#### `late` *(function)*",
    ])
  })

  it("folds dropped Symbols under a <details> block, by id, with their reasons", () => {
    const dropped = [
      droppedSymbol("ts:src/dto.ts#Zed", "pure DTO"),
      droppedSymbol("ts:src/dto.ts#Dto", "DTO shape"),
    ]
    expect(sectionOf(componentPage(dropped), "## Dropped")).toEqual([
      "## Dropped",
      "",
      "<details>",
      "<summary>2 dropped symbols</summary>",
      "",
      "- `ts:src/dto.ts#Dto` — `DTO shape`",
      "- `ts:src/dto.ts#Zed` — `pure DTO`",
      "",
      "</details>",
      "",
    ])
  })

  it("writes no fold-out for an empty list", () => {
    expect(droppedFoldout([])).toBe("")
  })

  it.each([null, ""])("refuses a dropped Symbol whose reason is %j", (dropReason) => {
    expect(() => componentPage([droppedSymbol("ts:src/dto.ts#Dto", dropReason)])).toThrow(
      ProjectionInvariantError,
    )
  })
})

describe("projectComponent — Dependencies", () => {
  const callEdge = dependency({
    from: "ts:src/billing/caller.ts#caller",
    to: "ts:src/util.ts#helper",
    via: "call",
  })
  const caller = makeSymbol({ id: "ts:src/billing/caller.ts#caller", name: "caller" })

  it("lists this component's edges in (from, to, via) order and lifts its Symbols' edges into their own list", () => {
    const md = componentPage([caller], {
      dependencies: [
        dependency({ from: "billing", to: "payments", via: "import" }),
        callEdge,
        dependency({ from: "audit", to: "billing", via: "import", effect: "db.write" }),
        dependency({ from: "billing", to: "audit", via: "import" }),
        dependency({ from: "billing", to: "audit", via: "event" }),
        dependency({ from: "orders", to: "payments", via: "import" }),
      ],
    })
    expect(sectionOf(md, "## Dependencies")).toEqual([
      "## Dependencies",
      "",
      "- `audit` → `billing` (via `import`) [db.write]",
      "- `billing` → `audit` (via `event`)",
      "- `billing` → `audit` (via `import`)",
      "- `billing` → `payments` (via `import`)",
      "",
      "### Symbol edges",
      "- `ts:src/billing/caller.ts#caller` → `ts:src/util.ts#helper` (via `call`)",
      "",
    ])
  })

  it("leaves out the Symbol edges list when none of this component's Symbols has one", () => {
    const md = componentPage([makeSymbol({ id: "ts:src/billing/foo.ts#foo", name: "foo" })], {
      dependencies: [dependency({ from: "billing", to: "payments" }), callEdge],
    })
    expect(md).toContain("- `billing` → `payments` (via `import`)")
    expect(md).not.toContain("### Symbol edges")
  })

  it("writes the section for Symbol edges alone", () => {
    expect(
      sectionOf(componentPage([caller], { dependencies: [callEdge] }), "## Dependencies"),
    ).toEqual([
      "## Dependencies",
      "",
      "### Symbol edges",
      "- `ts:src/billing/caller.ts#caller` → `ts:src/util.ts#helper` (via `call`)",
      "",
    ])
  })
})

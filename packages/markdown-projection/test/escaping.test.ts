import { describe, expect, it } from "vitest"
import {
  callRow,
  codeFragment,
  effectRow,
  inlineCode,
  projectComponent,
  projectSymbolExplain,
  projectWorkspace,
  ruleRow,
  tableCell,
} from "../src"
import { component, effect, makeIR, makeSymbol, rule, symbolId } from "./fixtures"

/**
 * §3.4 / §5.6 — the three ways a value out of the IR used to escape the construct that
 * was meant to contain it: a fence opened at column 0 inside a list item, a backtick
 * closing a code span early, and a `|` opening a table column the header never declared.
 *
 * Every value asserted here is ordinary source text — a boolean condition long enough to
 * fence, a template literal, a path with a pipe in it — not a crafted hostile string.
 */

function longCondition(): string {
  return "user.role === 'admin' && flags.enabled && !session.expired && ctx.tenant === wantedTenantName"
}

/**
 * Values whose `${...}` belongs to the source being described, not to this file. Written as
 * escaped template literals so they read as the TypeScript they stand for.
 */
const THROWN_TEMPLATE = `new Error(\`unknown kind: \${k}\`)`
const CACHE_KEY_TEMPLATE = `redis.get(\`k:\${id}\`)`

describe("inlineCode", () => {
  it("widens the fence past the longest interior backtick run", () => {
    expect(inlineCode("a `b` c")).toBe("``a `b` c``")
    expect(inlineCode("a ``b`` c")).toBe("```a ``b`` c```")
  })

  it("pads when the value opens or closes with a backtick, so CommonMark keeps it whole", () => {
    expect(inlineCode("`x`")).toBe("`` `x` ``")
  })

  it("leaves a value with no backtick and no edge space in a one-backtick span", () => {
    expect(inlineCode("x > 0")).toBe("`x > 0`")
  })

  it("collapses newline runs, because a code span is one row by construction", () => {
    expect(inlineCode("a\n  b")).toBe("`a b`")
  })

  it("renders the empty string as nothing rather than as two literal backticks", () => {
    expect(inlineCode("")).toBe("")
  })
})

describe("codeFragment", () => {
  it("widens the block fence past a fence-length run inside the source", () => {
    const source = `${"x".repeat(90)}\n\`\`\`\ny`
    const rendered = codeFragment(source)
    expect(rendered.startsWith("\n````\n")).toBe(true)
    expect(rendered.endsWith("\n````\n")).toBe(true)
  })

  it("keeps the three-backtick fence when the source holds none", () => {
    expect(codeFragment("short", { forceFence: true })).toBe("\n```\nshort\n```\n")
  })

  it("routes the inline branch through the widening span", () => {
    expect(codeFragment("key === `x`")).toBe("`` key === `x` ``")
  })
})

describe("tableCell", () => {
  it("escapes the pipe that would otherwise open a column", () => {
    expect(tableCell("`pipe(a|b)`")).toBe("`pipe(a\\|b)`")
  })

  it("maps a newline to a break, because a GFM row ends at one", () => {
    expect(tableCell("a\nb")).toBe("a<br>b")
  })
})

describe("ruleRow — a value that has to fence stays inside its list item", () => {
  it("moves the line tag ahead of the fence and indents the block into the item", () => {
    const row = ruleRow(rule({ type: "guard", line: 3, condition: longCondition() }))
    expect(row.split("\n")).toEqual(["- guard (L3):", "  ```", `  ${longCondition()}`, "  ```"])
  })

  it("keeps the compact row for a condition that fits inline", () => {
    expect(ruleRow(rule({ type: "guard", line: 5, condition: "x > 0" }))).toBe(
      "- guard: `x > 0` (L5)",
    )
  })

  it("does not let a template literal close the span early", () => {
    expect(ruleRow(rule({ type: "throw", line: 3, what: THROWN_TEMPLATE }))).toBe(
      `- throw: \`\`${THROWN_TEMPLATE}\`\` (L3)`,
    )
  })

  it("fences a multiline condition under the item as well", () => {
    const row = ruleRow(rule({ type: "switch", line: 9, condition: "a\nb" }))
    expect(row.split("\n")).toEqual(["- switch (L9):", "  ```", "  a", "  b", "  ```"])
  })

  it("keeps the rules of one symbol in a single list", () => {
    const md = projectComponent({
      component: component({ id: "billing", name: "Billing" }),
      symbols: [
        makeSymbol({
          id: "ts:src/a.ts#f",
          name: "f",
          component: "billing",
          rules: [
            rule({ type: "guard", line: 3, condition: longCondition() }),
            rule({ type: "loop", line: 9, loopKind: "for" }),
          ],
        }),
      ],
      dependencies: [],
    })
    // Every line between the label and the last rule belongs to the list: either a
    // top-level item or the indented fence of one. A column-0 fence would end it.
    const body = md.slice(md.indexOf("**Rules**:"), md.indexOf("- loop"))
    for (const line of body.split("\n").slice(1)) {
      if (line === "") continue
      expect(line.startsWith("- ") || line.startsWith("  ")).toBe(true)
    }
  })
})

describe("inline code spans elsewhere in the row", () => {
  it("survives a backtick in an effect target", () => {
    expect(
      effectRow(effect({ id: "cache.read", target: CACHE_KEY_TEMPLATE, plugin: "effects-redis" })),
    ).toBe(`- cache.read: \`\`${CACHE_KEY_TEMPLATE}\`\` (L1) [effects-redis]`)
  })

  it("survives a backtick in a call target", () => {
    expect(callRow({ target: "sql`select 1`", line: 4, resolved: null })).toBe(
      "- `` sql`select 1` `` (L4)",
    )
  })
})

describe("table cells keep their column count", () => {
  function cellCount(row: string): number {
    return row.split(/(?<!\\)\|/g).length
  }

  it("holds the Components table to five columns when a root carries a pipe", () => {
    const md = projectWorkspace(
      makeIR({
        components: [component({ id: "web", name: "Web", roots: ["apps/a|b"] })],
      }),
    )
    const header = md.split("\n").find((l) => l.startsWith("| id |")) ?? ""
    const row = md.split("\n").find((l) => l.startsWith("| web |")) ?? ""
    expect(row).not.toBe("")
    expect(cellCount(row)).toBe(cellCount(header))
  })

  it("holds the effect surface table when an effect target carries a pipe", () => {
    const md = projectWorkspace(
      makeIR({
        components: [component({ id: "web", name: "Web" })],
        symbols: [
          makeSymbol({
            id: "ts:src/a.ts#f",
            name: "f",
            component: "web",
            effects: [effect({ id: "http.route", target: "GET /a|b", plugin: "framework-next" })],
          }),
        ],
      }),
    )
    const header = md.split("\n").find((l) => l.startsWith("| effect |")) ?? ""
    const row = md.split("\n").find((l) => l.startsWith("| http.route |")) ?? ""
    expect(row).not.toBe("")
    expect(cellCount(row)).toBe(cellCount(header))
  })

  it("holds the call resolution table when a call target carries a pipe", () => {
    const caller = makeSymbol({
      id: "ts:src/ctl.ts#Ctl.route",
      name: "Ctl.route",
      calls: [{ target: "pipe(a|b)", line: 3, resolved: null }],
    })
    const md = projectSymbolExplain(caller, {
      unresolvedCalls: [
        {
          symbolId: symbolId("ts:src/ctl.ts#Ctl.route"),
          target: "pipe(a|b)",
          line: 3,
          bucket: "no-match",
          candidates: [],
        },
      ],
    })
    const header = md.split("\n").find((l) => l.startsWith("| line |")) ?? ""
    const row = md.split("\n").find((l) => l.startsWith("| 3 |")) ?? ""
    expect(row).not.toBe("")
    expect(cellCount(row)).toBe(cellCount(header))
    expect(row).toContain("pipe(a\\|b)")
  })
})

describe("the component id column stays a component id", () => {
  it("escapes a pipe in a component id rather than shifting the row", () => {
    const md = projectWorkspace(makeIR({ components: [component({ id: "a|b", name: "A" })] }))
    expect(md).toContain("| a\\|b |")
  })
})

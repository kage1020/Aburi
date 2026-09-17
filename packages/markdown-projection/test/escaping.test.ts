import { component, effect, makeIR, makeSymbol, rule, symbolId } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import {
  callRow,
  codeFragment,
  effectRow,
  INLINE_CODE_MAX_LENGTH,
  inlineCode,
  projectComponent,
  projectSymbolExplain,
  projectWorkspace,
  ruleRow,
  tableCell,
} from "../src"

/**
 * Code fragment and Rule row display (markdown-projection.md) — the three ways a value out
 * of the IR used to escape the construct that was meant to contain it: a fence opened at
 * column 0 inside a list item, a backtick closing a code span early, and a `|` opening a
 * table column the header never declared.
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

  it("names the empty string, because an empty code span cannot be written", () => {
    expect(inlineCode("")).toBe("(empty)")
  })

  it("pads an edge space too, so the value keeps the space it was given", () => {
    expect(inlineCode(" x")).toBe("`  x `")
    expect(inlineCode("x ")).toBe("` x  `")
  })

  it("treats a lone carriage return as the line break CommonMark reads it as", () => {
    expect(inlineCode("a\rb")).toBe("`a b`")
    expect(tableCell("a\rb")).toBe("a<br>b")
  })

  it("cannot round-trip a value that is only spaces", () => {
    // CommonMark strips one space from each end only when the content is not entirely
    // spaces, so the padding stays visible here. Recorded rather than fixed: no span can
    // carry this value exactly, and no IR field this package renders holds one.
    expect(inlineCode(" ")).toBe("`   `")
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

  it("doubles the backslash run in front of the pipe, so the escape is not itself escaped", () => {
    expect(tableCell("a\\|b")).toBe("a\\\\\\|b")
  })

  it("leaves a backslash that no pipe follows alone", () => {
    expect(tableCell("C:\\src")).toBe("C:\\src")
  })
})

describe("ruleRow — a value that has to fence stays inside its list item", () => {
  it("moves the line tag ahead of the fence and indents the block into the item", () => {
    expect(ruleRow(rule({ type: "guard", line: 3, condition: longCondition() }))).toEqual([
      "- guard (L3):",
      "  ```",
      `  ${longCondition()}`,
      "  ```",
    ])
  })

  it("fences at one character past the threshold and not at the threshold", () => {
    const at = "x".repeat(INLINE_CODE_MAX_LENGTH)
    const past = "x".repeat(INLINE_CODE_MAX_LENGTH + 1)
    expect(ruleRow(rule({ type: "guard", line: 1, condition: at }))).toEqual([
      `- guard: \`${at}\` (L1)`,
    ])
    expect(ruleRow(rule({ type: "guard", line: 1, condition: past }))[0]).toBe("- guard (L1):")
  })

  it("names an empty payload instead of rendering a row that trails off", () => {
    // `Rule.condition` carries a maxLength and no minLength in aburi.ir.v1, so this is a
    // document to render, not an invariant to throw on.
    expect(ruleRow(rule({ type: "guard", line: 5, condition: "" }))).toEqual([
      "- guard: (empty) (L5)",
    ])
  })

  it("does not let a template literal close the span early", () => {
    expect(ruleRow(rule({ type: "throw", line: 3, what: THROWN_TEMPLATE }))).toEqual([
      `- throw: \`\`${THROWN_TEMPLATE}\`\` (L3)`,
    ])
  })

  it("fences a multiline condition under the item as well", () => {
    // ir-schema.md has the extractor strip newlines from this field; a writer that did
    // not is the reason the branch exists, so the row still has to hold together.
    expect(ruleRow(rule({ type: "switch", line: 9, condition: "a\nb" }))).toEqual([
      "- switch (L9):",
      "  ```",
      "  a",
      "  b",
      "  ```",
    ])
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
  /**
   * How many cells GFM reads in this row, scanned the way cmark-gfm does rather than the way
   * `tableCell` writes: a backslash and the character after it are one escape pair and neither
   * can delimit, so `\\|` is an escaped backslash followed by a live delimiter. A lookbehind on
   * the pipe would instead share `tableCell`'s own assumption and pass on output GFM splits.
   */
  function cellCount(row: string): number {
    let cells = 1
    for (let i = 0; i < row.length; i++) {
      if (row[i] === "\\") {
        i++
        continue
      }
      if (row[i] === "|") cells++
    }
    return cells
  }

  it("holds the Components table to five columns when a root carries a pipe", () => {
    // `RelativePath` forbids a backslash and nothing else, so a root is the cell in this table
    // that can carry a pipe. `ComponentId` is kebab-case and cannot.
    const md = projectWorkspace(
      makeIR({
        components: [component({ id: "web", name: "Web", roots: ["apps/a|b"] })],
      }),
    )
    const header = md.split("\n").find((l) => l.startsWith("| id |")) ?? ""
    const row = md.split("\n").find((l) => l.startsWith("| web |")) ?? ""
    expect(row).not.toBe("")
    expect(cellCount(row)).toBe(cellCount(header))
    expect(row).toContain("apps/a\\|b")
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

  it("holds it when the target carries a backslash in front of the pipe", () => {
    // `Call.target` is `minLength: 1` and nothing else — the one cell in any of these tables
    // that can hold both characters. A single backslash before the escape would pair with it
    // and hand the pipe back to the row scanner.
    const target = "pipe(a\\|b)"
    const caller = makeSymbol({
      id: "ts:src/ctl.ts#Ctl.route",
      name: "Ctl.route",
      calls: [{ target, line: 4, resolved: null }],
    })
    const md = projectSymbolExplain(caller, { unresolvedCalls: [] })
    const header = md.split("\n").find((l) => l.startsWith("| line |")) ?? ""
    const row = md.split("\n").find((l) => l.startsWith("| 4 |")) ?? ""
    expect(row).not.toBe("")
    expect(cellCount(row)).toBe(cellCount(header))
  })
})

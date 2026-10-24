import {
  changed,
  component,
  decorator,
  dependency,
  effect,
  makeDiff,
  makeIR,
  makeSymbol,
  rule,
  sig,
  symbolId,
} from "@aburi/test-support"
import type { IR, Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  callRow,
  codeFragment,
  effectRow,
  INLINE_CODE_MAX_LENGTH,
  inlineCode,
  projectComponent,
  projectDiff,
  projectSymbolExplain,
  projectWorkspace,
  ruleRow,
  tableCell,
} from "../src"
import {
  componentPage,
  droppedSymbol,
  LONG_CONDITION,
  namedSymbol,
  projectChanges,
} from "./fixtures"
import { sectionOf, shownText } from "./markdown"

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
    expect(ruleRow(rule({ type: "guard", line: 3, condition: LONG_CONDITION }))).toEqual([
      "- guard (L3):",
      "  ```",
      `  ${LONG_CONDITION}`,
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
            rule({ type: "guard", line: 3, condition: LONG_CONDITION }),
            rule({ type: "loop", line: 9, loopKind: "for" }),
          ],
        }),
      ],
      dependencies: [],
    })
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

describe("a value written into a row of the report", () => {
  // Not shaped like a Symbol id, so as an edge endpoint it stays a component-level one.
  const VALUE = "src/_x_/*x*/<T>/`y`/~~s~~\n## z"
  const SHOWN = "src/_x_/*x*/<T>/`y`/~~s~~ ## z"

  const handler = (overrides: Parameters<typeof namedSymbol>[1]) =>
    namedSymbol("handler", overrides)
  const dropped = (dropReason: string) => droppedSymbol("ts:src/handler.ts#handler", dropReason)
  const propagatedFrom = (source: string) =>
    effect({
      id: "db.write",
      target: "prisma.user.create",
      plugin: "effects-prisma",
      propagated: true,
      derivedFrom: [source],
    })
  const page = (symbols: IRSymbol[], name = "Billing") =>
    componentPage(symbols, { of: component({ id: "billing", name }) })
  const edgePage = (from: string) =>
    componentPage([], { dependencies: [dependency({ from, to: "billing" })] })
  const edgeList = (from: string) => {
    const md = projectWorkspace(
      makeIR({
        components: [component({ id: "billing", name: "Billing" })],
        dependencies: [dependency({ from, to: "billing" })],
      }),
    )
    return md.slice(md.indexOf("Fallback list:"))
  }
  const generatedBy = (
    generator: Partial<IR["generator"]>,
    generatedAt = "2026-01-02T03:04:05Z",
  ) => {
    const ir = makeIR()
    return projectWorkspace({ ...ir, generator: { ...ir.generator, ...generator }, generatedAt })
  }
  const titled = (refs: { base?: string; head?: string }) => {
    const diff = makeDiff()
    return projectDiff({
      ...diff,
      base: { ...diff.base, ref: refs.base ?? diff.base.ref },
      head: { ...diff.head, ref: refs.head ?? diff.head.ref },
    })
  }

  it.each([
    "_x_",
    "*x*",
    "<T>",
    "`y`",
    "a\n## z",
    "~~s~~",
  ])("%j is rewritten by CommonMark when written bare", (hazard) => {
    expect(shownText(`- ${hazard}`)).not.toContain(hazard.replace("\n", " "))
  })

  it.each<[string, (value: string) => string]>([
    ["a thrown type", (value) => page([handler({ signature: sig({ throws: [value] }) })])],
    [
      "a propagated effect's direct source",
      (value) => page([handler({ effects: [propagatedFrom(value)] })]),
    ],
    [
      "a direct source in the Boundary effect surface",
      (value) =>
        sectionOf(
          page([
            handler({
              decorators: [decorator({ name: "Post", boundary: true })],
              effects: [propagatedFrom(value)],
            }),
          ]),
          "## Boundary effect surface",
        ).join("\n"),
    ],
    [
      "a direct source in a delta row",
      (value) =>
        projectChanges([
          changed(namedSymbol("Foo"), {
            logicChanged: true,
            effects: { added: [propagatedFrom(value)], removed: [], modified: [] },
          }),
        ]),
    ],
    ["a Component name", (value) => page([], value)],
    ["a component-level edge endpoint on the component page", edgePage],
    ["a component-level edge endpoint in the workspace edge list", edgeList],
    ["the generator name in the workspace header", (value) => generatedBy({ name: value })],
    ["the generator version in the workspace header", (value) => generatedBy({ version: value })],
    ["the generation time in the workspace header", (value) => generatedBy({}, value)],
    ["the base ref in the diff title", (value) => titled({ base: value })],
    ["the head ref in the diff title", (value) => titled({ head: value })],
    ["a drop reason on the component page", (value) => page([dropped(value)])],
    [
      "a drop reason in Dropped changes",
      (value) =>
        projectChanges([
          {
            status: "dropped-toggled",
            before: handler({}),
            after: dropped(value),
            direction: "to-dropped",
          },
        ]),
    ],
    ["a drop reason in explain", (value) => projectSymbolExplain(dropped(value))],
  ])("keeps %s as written, its line break as a space", (_, render) => {
    expect(shownText(render(VALUE))).toContain(SHOWN)
  })

  it.each([
    ["0123456789abcdef0123456789abcdef01234567", "0123456789abcdef0123456789abcdef01234567"],
    ["0123abc", "0123abc"],
    ["abc123", "`abc123`"],
    ["0123ABC", "`0123ABC`"],
    ["feat/_wip_", "`feat/_wip_`"],
  ])("writes the head ref %j in the diff title as %s", (ref, shown) => {
    expect(titled({ head: ref }).split("\n")[0]).toBe(`# Aburi diff: \`main\`..${shown}`)
  })
})

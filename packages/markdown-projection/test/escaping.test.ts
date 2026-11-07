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
  tableHeader,
  tableRow,
} from "../src"
import {
  componentPage,
  droppedSymbol,
  LONG_CONDITION,
  namedSymbol,
  projectChanges,
} from "./fixtures"
import { sectionOf, shownText } from "./markdown"
import { blocksUnder, first, type Inline, rendered, renderedInline } from "./rendered"

const THROWN_TEMPLATE = `new Error(\`unknown kind: \${k}\`)`
const CACHE_KEY_TEMPLATE = `redis.get(\`k:\${id}\`)`

describe("inlineCode", () => {
  it.each([
    "x > 0",
    "a `b` c",
    "a ``b`` c",
    "`x`",
    "``",
    " x",
    "x ",
    " ",
    "   ",
    "a\\b",
    "<T>",
    "*x*",
    THROWN_TEMPLATE,
    CACHE_KEY_TEMPLATE,
  ])("writes %j as a code span a renderer reads back whole", (value) => {
    expect(renderedInline(inlineCode(value)).code).toEqual([value])
  })

  it.each(["a\n  b", "a\r\nb", "a\rb"])(
    "reads the line break in %j as the one space CommonMark makes of it",
    (value) => {
      expect(renderedInline(inlineCode(value)).code).toEqual(["a b"])
    },
  )

  it("names the empty string, because an empty code span cannot be written", () => {
    expect(inlineCode("")).toBe("(empty)")
  })
})

describe("codeFragment", () => {
  it.each([`${"x".repeat(90)}\n\`\`\`\ny`, "````\na", "  ```\n  x\n  ```", "~~~\nz"])(
    "fences %j in a block a renderer reads back whole",
    (source) => {
      expect(first(rendered(codeFragment(source)), "code").content).toBe(`${source}\n`)
    },
  )

  it("keeps the three-backtick fence when the source holds none", () => {
    expect(codeFragment("short", { forceFence: true })).toBe("\n```\nshort\n```\n")
  })

  it("routes the inline branch through the widening span", () => {
    expect(codeFragment("key === `x`")).toBe("`` key === `x` ``")
  })
})

describe("tableCell", () => {
  const AWKWARD = [
    "a|b",
    "a\\|b",
    "a\\\\|b",
    "|",
    "\\|",
    "|\\",
    "\\",
    "a\\",
    "x | y \\| z",
    "C:\\src",
  ]

  /** The one row of a two-column table whose first cell holds `markdown`. */
  function rowHolding(markdown: string): readonly Inline[] {
    const table = first(
      rendered([...tableHeader(["cell", "next"]), tableRow([markdown, "next"])].join("\n")),
      "table",
    )
    expect(table.rows).toHaveLength(1)
    return table.rows[0] ?? []
  }

  it.each([
    ...AWKWARD,
    ...AWKWARD.map((value) => inlineCode(value)),
    "a\nb",
    "a\rb",
    "p|q `c|d` r\\|s",
    "\\`a|b`",
    "`unclosed|",
    "``a`|`b``",
  ])("reads %j in its own column, as it reads outside a table", (markdown) => {
    expect(rowHolding(markdown)).toEqual([renderedInline(markdown), { text: "next", code: [] }])
  })
})

describe("a projection's tables, as a renderer reads them", () => {
  const VALUES = ["apps/a|b", "pipe(a\\|b)", "x\\\\|y", "`|`"]
  // A Symbol id admits a pipe but no backslash.
  const CANDIDATES = [symbolId("ts:src/a|b.ts#f"), symbolId("ts:src/c.ts#g|h")]

  function columns(md: string, header: readonly string[]) {
    const table = rendered(md).find(
      (block) =>
        block.kind === "table" && block.head.map((cell) => cell.text).join() === header.join(),
    )
    if (table?.kind !== "table") throw new Error(`no table headed ${header.join(", ")}`)
    for (const row of table.rows) expect(row).toHaveLength(header.length)
    return table.rows
  }

  it("keeps every Components row to the header's columns, each root whole", () => {
    const md = projectWorkspace(
      makeIR({ components: [component({ id: "web", name: "Web", roots: VALUES })] }),
    )
    const [row] = columns(md, ["id", "roots", "languages", "frameworks", "symbols"])
    expect(row?.[1]?.code).toEqual(VALUES)
  })

  it("keeps every call resolution row to the header's columns, each target and candidate whole", () => {
    const calls = VALUES.map((target, i) => ({ target, line: i + 1, resolved: null }))
    const caller = makeSymbol({ id: "ts:src/ctl.ts#Ctl.route", name: "Ctl.route", calls })
    const md = projectSymbolExplain(caller, {
      unresolvedCalls: calls.map((c) => ({
        symbolId: symbolId("ts:src/ctl.ts#Ctl.route"),
        target: c.target,
        line: c.line,
        bucket: "ambiguous",
        candidates: CANDIDATES,
      })),
    })
    const rows = columns(md, ["line", "target", "resolved", "bucket", "candidates"])
    expect(rows.map((row) => row[1]?.code)).toEqual(VALUES.map((value) => [value]))
    for (const row of rows) expect(row[4]?.code).toEqual(CANDIDATES)
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

  it("renders a Symbol's rules as one list, each fenced payload inside its own item", () => {
    const md = projectComponent({
      component: component({ id: "billing", name: "Billing" }),
      symbols: [
        makeSymbol({
          id: "ts:src/a.ts#f",
          name: "f",
          component: "billing",
          rules: [
            rule({ type: "guard", line: 3, condition: LONG_CONDITION }),
            rule({ type: "switch", line: 5, condition: "a\n```\nb" }),
            rule({ type: "loop", line: 9, loopKind: "for" }),
            rule({ type: "throw", line: 12, what: THROWN_TEMPLATE }),
          ],
        }),
      ],
      dependencies: [],
    })
    const under = blocksUnder(rendered(md), "Rules:")
    expect(under).toHaveLength(1)
    const items = first(under, "list").items
    expect(items.map((item) => item.map((block) => block.kind))).toEqual([
      ["paragraph", "code"],
      ["paragraph", "code"],
      ["paragraph"],
      ["paragraph"],
    ])
    expect(items.flatMap((item) => item.filter((block) => block.kind === "code"))).toEqual([
      { kind: "code", content: `${LONG_CONDITION}\n` },
      { kind: "code", content: "a\n```\nb\n" },
    ])
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

  it.each(["_x_", "*x*", "<T>", "`y`", "a\n## z", "~~s~~"])(
    "%j is rewritten by CommonMark when written bare",
    (hazard) => {
      expect(shownText(`- ${hazard}`)).not.toContain(hazard.replace("\n", " "))
    },
  )

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

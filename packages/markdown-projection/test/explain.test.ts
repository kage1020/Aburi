import {
  call,
  decorator,
  dependency,
  effect,
  fp,
  makeSymbol,
  rule,
  sig,
  symbolId,
  zeroFp,
} from "@aburi/test-support"
import type { UnresolvedCallDiagnostic } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { projectSymbolExplain } from "../src"
import { headings, sectionOf } from "./markdown"

const CALLER_ID = symbolId("ts:src/ctl.ts#Ctl.route")

describe("projectSymbolExplain — a kept Symbol", () => {
  const symbol = makeSymbol({
    id: "ts:src/a.ts#Foo.bar",
    name: "Foo.bar",
    kind: "method",
    component: "billing",
    signature: sig({ inputs: [{ name: "id", type: "string" }], outputs: ["Promise<User>"] }),
    decorators: [
      decorator({ name: "Post", raw: "Post('/x')", boundary: true }),
      decorator({ name: "UseGuards", raw: "UseGuards(Auth)" }),
    ],
    rules: [rule({ type: "throw", line: 8, what: "new E()" })],
    effects: [
      effect({ id: "db.read", target: "prisma.user.findFirst", plugin: "effects-prisma", line: 6 }),
    ],
    calls: [call({ target: "helper.doWork", line: 7 })],
    derivedBy: ["framework:nestjs:controller", "effects-plugin:prisma:read"],
    fingerprint: fp("v1"),
  })
  const md = projectSymbolExplain(symbol)

  it("gives every axis a section of its own, in a fixed order", () => {
    expect(headings(md)).toEqual([
      "## Boundary",
      "## Decorators",
      "## Signature",
      "## Rules",
      "## Effects",
      "## Calls",
      "## Derived by",
      "## Fingerprint",
    ])
  })

  it("opens with where the Symbol lives", () => {
    expect(md.split("\n").slice(0, 7)).toEqual([
      "# `Foo.bar` *(method)*",
      "",
      "**Component**: billing",
      "**File**: `src/a.ts:1-10`",
      "**Visibility**: public",
      "**Language**: ts",
      "",
    ])
  })

  it("lists derivedBy sorted and the fingerprint in full", () => {
    expect(sectionOf(md, "## Derived by")).toEqual([
      "## Derived by",
      "",
      "- `effects-plugin:prisma:read`",
      "- `framework:nestjs:controller`",
      "",
    ])
    expect(sectionOf(md, "## Fingerprint")).toEqual([
      "## Fingerprint",
      "",
      "- api: `000000api-v1`",
      "- logic: `000000log-v1`",
      "- syntax: `000000syn-v1`",
      "",
    ])
  })
})

describe("projectSymbolExplain — a dropped Symbol", () => {
  const dto = (dropReason: string) =>
    makeSymbol({
      id: "ts:src/a.ts#Dto",
      name: "Dto",
      kind: "class",
      dropped: true,
      dropReason,
      fingerprint: zeroFp(),
    })

  it("shows the drop reason in place of the axis sections", () => {
    expect(projectSymbolExplain(dto("pure DTO"))).toBe(
      [
        "# `Dto` *(class)* — dropped",
        "",
        "**File**: `src/a.ts:1-10`",
        "**Drop reason**: pure DTO",
        "",
        "_(dropped symbols carry no rules / effects / calls / fingerprint by IR contract.)_",
        "",
      ].join("\n"),
    )
  })

  it("leaves a multi-line drop reason exactly as the producer wrote it", () => {
    expect(projectSymbolExplain(dto("matched rule A\n\n\nmatched rule B"))).toContain(
      "matched rule A\n\n\nmatched rule B",
    )
  })
})

describe("projectSymbolExplain — ## Called by", () => {
  const helper = makeSymbol({ id: "ts:src/util.ts#helper", name: "helper" })
  const callFrom = (from: string) =>
    dependency({ from, to: "ts:src/util.ts#helper", via: "call", direction: "outbound" })

  it("lists every caller once, sorted, from the call edges into this Symbol", () => {
    const md = projectSymbolExplain(helper, {
      dependencies: [
        callFrom("ts:src/z.ts#z"),
        callFrom("ts:src/a.ts#a"),
        callFrom("ts:src/z.ts#z"),
        dependency({ from: "ts:src/b.ts#b", to: "ts:src/util.ts#helper", via: "import" }),
        dependency({ from: "ts:src/c.ts#c", to: "ts:src/util.ts#other", via: "call" }),
      ],
    })
    expect(sectionOf(md, "## Called by")).toEqual([
      "## Called by",
      "",
      "- `ts:src/a.ts#a`",
      "- `ts:src/z.ts#z`",
      "",
    ])
  })

  it.each([
    ["no call edge targets this Symbol", { dependencies: [] }],
    ["no dependencies are supplied", {}],
  ])("is left out when %s", (_, context) => {
    expect(projectSymbolExplain(helper, context)).not.toContain("## Called by")
  })
})

describe("projectSymbolExplain — ## Call resolution", () => {
  function caller() {
    return makeSymbol({
      id: CALLER_ID,
      name: "Ctl.route",
      calls: [
        { target: "User.save", line: 16, resolved: null },
        { target: "svc.refund", line: 12, resolved: symbolId("ts:src/svc.ts#Svc.refund") },
        { target: "factory.save", line: 14, resolved: null },
      ],
    })
  }

  const diagnostics: UnresolvedCallDiagnostic[] = [
    { symbolId: CALLER_ID, target: "factory.save", line: 14, bucket: "dynamic", candidates: [] },
    {
      symbolId: CALLER_ID,
      target: "User.save",
      line: 16,
      bucket: "ambiguous",
      candidates: ["ts:src/a.ts#User.save", "ts:src/b.ts#User.save"].map(symbolId),
    },
  ]

  it("writes one row per call site, by line, with the resolved callee or the bucket", () => {
    expect(
      sectionOf(
        projectSymbolExplain(caller(), { unresolvedCalls: diagnostics }),
        "## Call resolution",
      ),
    ).toEqual([
      "## Call resolution",
      "",
      "| line | target | resolved | bucket | candidates |",
      "|---|---|---|---|---|",
      "| 12 | `svc.refund` | `ts:src/svc.ts#Svc.refund` | — | — |",
      "| 14 | `factory.save` | — | `dynamic` | — |",
      "| 16 | `User.save` | — | `ambiguous` | `ts:src/a.ts#User.save`<br>`ts:src/b.ts#User.save` |",
      "",
    ])
  })

  it("ignores diagnostics belonging to other Symbols", () => {
    const md = projectSymbolExplain(caller(), {
      unresolvedCalls: [
        {
          symbolId: symbolId("ts:src/other.ts#other"),
          target: "factory.save",
          line: 14,
          bucket: "no-match",
          candidates: [],
        },
      ],
    })
    expect(md).toContain("| 14 | `factory.save` | — | — | — |")
    expect(md).not.toContain("no-match")
  })

  it("says so explicitly when the Symbol has no call sites", () => {
    const md = projectSymbolExplain(makeSymbol({ id: CALLER_ID, name: "Ctl.route" }), {
      unresolvedCalls: [],
    })
    expect(sectionOf(md, "## Call resolution")).toEqual([
      "## Call resolution",
      "",
      "_(no call sites)_",
      "",
    ])
  })

  it("leaves the default output byte-identical when no diagnostics are supplied", () => {
    const withoutContext = projectSymbolExplain(caller())
    expect(withoutContext).not.toContain("Call resolution")
    expect(projectSymbolExplain(caller(), { dependencies: [] })).toBe(withoutContext)
  })
})

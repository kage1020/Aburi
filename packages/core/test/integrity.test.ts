import { component, dependency, effect, makeIR } from "@aburi/test-support"
import type { IR } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { makeLanguageId } from "../src/id"
import { assertIRIntegrity, CoreError, checkIRIntegrity, isCoreEffectId } from "../src/index"
import { makeSymbol } from "./fixtures/ir"
import { WORKSPACE_PATH_CASES } from "./fixtures/paths"

function sourceAt(file: string) {
  return { file, startLine: 1, endLine: 1, startColumn: null, endColumn: null }
}

function irWith(build: (ir: IR) => void): IR {
  const ir = makeIR()
  build(ir)
  return ir
}

function violationsOf(ir: IR, invariant: number) {
  return checkIRIntegrity(ir).filter((v) => v.invariant === invariant)
}

describe("checkIRIntegrity", () => {
  it("says nothing about an empty Document", () => {
    expect(checkIRIntegrity(makeIR())).toEqual([])
  })

  it.each<[string, (ir: IR) => void]>([
    [
      "a core effect id and an x-prefixed one",
      (ir) => {
        ir.symbols = [
          makeSymbol("ts:src/a.ts#foo", {
            effects: [
              effect({ id: "db.write", target: "prisma.user.create", plugin: "p", line: 1 }),
              effect({
                id: "x-stripe:charge",
                target: "stripe.charges.create",
                plugin: "p",
                line: 2,
              }),
            ],
          }),
        ]
      },
    ],
    [
      "no extKind and a multi-segment one",
      (ir) => {
        ir.symbols = [
          makeSymbol("ts:src/a.ts#a", { extKind: null }),
          makeSymbol("ts:src/a.ts#b", { extKind: "framework:nestjs:controller" }),
        ]
      },
    ],
    [
      "a Symbol in a declared Component",
      (ir) => {
        ir.components = [component({ id: "billing", name: "billing" })]
        ir.symbols = [makeSymbol("ts:src/a.ts#foo", { component: "billing" })]
      },
    ],
  ])("accepts %s", (_what, build) => {
    expect(checkIRIntegrity(irWith(build))).toEqual([])
  })

  it.each<[string, number, (ir: IR) => void]>([
    [
      "two Symbols under one id",
      1,
      (ir) => {
        ir.symbols = [makeSymbol("ts:src/a.ts#foo"), makeSymbol("ts:src/a.ts#foo")]
      },
    ],
    [
      "two Components under one id",
      2,
      (ir) => {
        ir.components = [
          component({ id: "a", name: "A" }),
          component({ id: "a", name: "A2", roots: ["apps/a2"] }),
        ]
      },
    ],
    [
      "a Symbol in an undeclared Component",
      3,
      (ir) => {
        ir.symbols = [makeSymbol("ts:src/a.ts#foo", { component: "missing" })]
      },
    ],
    [
      "a dropped Symbol without a dropReason",
      5,
      (ir) => {
        ir.symbols = [makeSymbol("ts:src/a.ts#foo", { dropped: true, dropReason: null })]
      },
    ],
    [
      "a dropped Symbol whose dropReason is blank",
      5,
      (ir) => {
        ir.symbols = [makeSymbol("ts:src/a.ts#foo", { dropped: true, dropReason: "  " })]
      },
    ],
    [
      "a confidence outside the enum",
      6,
      (ir) => {
        ir.symbols = [makeSymbol("ts:src/a.ts#foo", { confidence: "experimental" as never })]
      },
    ],
    [
      "an effect id neither in the core vocabulary nor x-prefixed",
      7,
      (ir) => {
        ir.symbols = [
          makeSymbol("ts:src/a.ts#foo", {
            effects: [effect({ id: "unknown.effect", target: "x", plugin: "p" })],
          }),
        ]
      },
    ],
    [
      "a kind outside the enum",
      8,
      (ir) => {
        ir.symbols = [makeSymbol("ts:src/a.ts#foo", { kind: "macro" as never })]
      },
    ],
    [
      "an extKind with a single segment",
      9,
      (ir) => {
        ir.symbols = [makeSymbol("ts:src/a.ts#foo", { extKind: "fponly" })]
      },
    ],
  ])("flags %s under invariant %i", (_what, invariant, build) => {
    expect(violationsOf(irWith(build), invariant)).toHaveLength(1)
  })

  it("answers the shared path table at every path site, with the stated reason", () => {
    for (const { path, root, why } of WORKSPACE_PATH_CASES) {
      const ir = irWith((ir) => {
        ir.components = [component({ id: "a", name: "a", roots: [path] })]
        ir.symbols = [makeSymbol("ts:src/a.ts#foo", { source: sourceAt(path) })]
        ir.workspace.managers = [{ tool: "pnpm", roots: [path] }]
      })

      const tenth = violationsOf(ir, 10)
      const label = `${JSON.stringify(path)} (${why})`
      if (root.ok) {
        expect(tenth, label).toEqual([])
        continue
      }
      expect(tenth.map((v) => v.subject).sort(), label).toEqual([
        "components[id=a].roots",
        "ts:src/a.ts#foo",
        "workspace.managers[tool=pnpm].roots",
      ])
      for (const violation of tenth) {
        expect(violation.message, `${label} @ ${violation.subject}`).toContain(root.reason)
      }
    }
  })
})

describe("isCoreEffectId", () => {
  it.each([
    ["db.write", true],
    ["process.signal", true],
    ["x-stripe:charge", false],
    ["db.upsert", false],
  ])("answers %j with %s: only the core vocabulary is ownerless", (id, core) => {
    expect(isCoreEffectId(id)).toBe(core)
  })
})

describe("assertIRIntegrity", () => {
  it("does not throw on a clean Document", () => {
    expect(() => assertIRIntegrity(makeIR())).not.toThrow()
  })

  it("throws one CoreError carrying every violation and naming each in its message", () => {
    const ir = irWith((ir) => {
      ir.symbols = [makeSymbol("ts:src/a.ts#foo"), makeSymbol("ts:src/a.ts#foo")]
    })

    expect(() => assertIRIntegrity(ir)).toThrow(CoreError)
    expect(() => assertIRIntegrity(ir)).toThrowError(
      expect.objectContaining({
        code: "integrity-violation",
        violations: checkIRIntegrity(ir),
        message: expect.stringContaining("[#1] ts:src/a.ts#foo: duplicate Symbol id"),
      }),
    )
  })
})

describe("checkIRIntegrity — id namespaces and grammars", () => {
  it.each<[string, number, (ir: IR) => void]>([
    [
      "a Symbol id in the reserved `slice:` namespace",
      16,
      (ir) => {
        ir.symbols = [makeSymbol("slice:src/a.ts#foo")]
      },
    ],
    [
      "a Dependency endpoint in the reserved `slice:` namespace",
      16,
      (ir) => {
        ir.symbols = [makeSymbol("ts:src/a.ts#foo")]
        ir.dependencies = [
          dependency({ from: "ts:src/a.ts#foo", to: "slice:src/b.ts#bar", via: "import" }),
        ]
      },
    ],
    [
      "a Symbol id that leaves the workspace",
      17,
      (ir) => {
        ir.symbols = [makeSymbol("ts:../../etc/passwd#foo")]
      },
    ],
    [
      "a Symbol id whose qualified name has an empty segment",
      17,
      (ir) => {
        ir.symbols = [makeSymbol("ts:src/a.ts#A.", { name: "A" })]
      },
    ],
    [
      "a Component id that is not kebab-case",
      17,
      (ir) => {
        ir.components = [component({ id: "Billing", name: "Billing" })]
      },
    ],
  ])("flags %s under invariant %i", (_what, invariant, build) => {
    expect(violationsOf(irWith(build), invariant)).toHaveLength(1)
  })

  it("flags a malformed Symbol.name even when the id is well-formed", () => {
    const ir = irWith((ir) => {
      ir.symbols = [makeSymbol("ts:src/a.ts#A", { name: "A." })]
    })
    const violations = violationsOf(ir, 17)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.message).toContain("Symbol.name")
  })

  it("leaves a language token that merely starts with the reserved one alone", () => {
    const ir = irWith((ir) => {
      ir.symbols = [makeSymbol("slicer:src/a.ts#foo"), makeSymbol("ts:src/b.ts#bar")]
    })
    expect(violationsOf(ir, 16)).toEqual([])
  })

  it("accepts the ids the constructors produce, including digit-leading components", () => {
    const ir = irWith((ir) => {
      ir.symbols = [
        makeSymbol("ts:src/a.ts#Cls::fromJson", { component: "3d-renderer" }),
        makeSymbol("ts:src/b.ts#<default>", { component: "3d-renderer" }),
      ]
      ir.components = [component({ id: "3d-renderer", name: "3d-renderer" })]
    })
    expect(violationsOf(ir, 17)).toEqual([])
  })
})

describe("checkIRIntegrity — workspace.languages", () => {
  it.each<[string, (ir: IR) => void, string]>([
    [
      "an empty list",
      (ir) => {
        ir.workspace.languages = []
      },
      "workspace.languages",
    ],
    [
      "a plugin manifest name in place of a LanguageId",
      (ir) => {
        ir.workspace.languages = ["lang-typescript" as unknown as IR["workspace"]["languages"][0]]
      },
      "workspace.languages",
    ],
    [
      "a Symbol whose language is not declared",
      (ir) => {
        ir.symbols = [makeSymbol("py:src/a.py#alpha", { language: makeLanguageId("py") })]
      },
      "py:src/a.py#alpha",
    ],
  ])("flags %s", (_what, build, subject) => {
    expect(violationsOf(irWith(build), 18).map((v) => v.subject)).toEqual([subject])
  })

  it("accepts a declared language that produced no Symbol", () => {
    const ir = irWith((ir) => {
      ir.workspace.languages = [makeLanguageId("ts"), makeLanguageId("py")]
      ir.symbols = [makeSymbol("ts:src/a.ts#alpha")]
    })
    expect(violationsOf(ir, 18)).toEqual([])
  })
})

describe("checkIRIntegrity — Unicode normalization", () => {
  const decomposed = "cafe\u0301"
  const composed = "caf\u00e9"

  it.each<[string, (ir: IR) => void]>([
    [
      "components[].roots",
      (ir) => {
        ir.components = [component({ id: "a", name: "a", roots: [`apps/${decomposed}`] })]
      },
    ],
    [
      "components[].publicApi",
      (ir) => {
        ir.components = [component({ id: "a", name: "a", publicApi: [`src/${decomposed}.ts`] })]
      },
    ],
    [
      "workspace.managers[].roots",
      (ir) => {
        ir.workspace.managers = [{ tool: "pnpm", roots: [`apps/${decomposed}`] }]
      },
    ],
    [
      "symbols[].source.file",
      (ir) => {
        ir.symbols = [makeSymbol("ts:src/a.ts#foo", { source: sourceAt(`${decomposed}.ts`) })]
      },
    ],
    [
      "symbols[].effects[].target",
      (ir) => {
        ir.symbols = [
          makeSymbol("ts:src/a.ts#foo", {
            effects: [effect({ id: "db.write", target: decomposed, plugin: "p" })],
          }),
        ]
      },
    ],
    [
      "symbols[].calls[].target",
      (ir) => {
        ir.symbols = [
          makeSymbol("ts:src/a.ts#foo", {
            calls: [{ target: decomposed, line: 1, resolved: null }],
          }),
        ]
      },
    ],
    [
      "dependencies[] endpoints",
      (ir) => {
        ir.components = [component({ id: "a", name: "a" }), component({ id: "b", name: "b" })]
        ir.dependencies = [dependency({ from: "a", to: decomposed, via: "import" })]
      },
    ],
  ])("reports %s", (_what, build) => {
    expect(violationsOf(irWith(build), 19)).toHaveLength(1)
  })

  it("says nothing about a Document that is already normalized", () => {
    const ir = irWith((ir) => {
      ir.components = [component({ id: "a", name: "a", roots: [`apps/${composed}`] })]
      ir.symbols = [
        makeSymbol("ts:src/a.ts#foo", { calls: [{ target: composed, line: 1, resolved: null }] }),
      ]
    })
    expect(checkIRIntegrity(ir)).toEqual([])
  })

  it("leaves the strings a Document only quotes alone: decorator source and signature types", () => {
    const ir = irWith((ir) => {
      ir.symbols = [
        makeSymbol("ts:src/a.ts#foo", {
          decorators: [
            { name: "D", raw: `D("${decomposed}")`, arguments: [], boundary: false, line: 1 },
          ],
          signature: {
            inputs: [{ name: "x", type: `"${decomposed}"` }],
            outputs: [`"${decomposed}"`],
            throws: [],
            async: false,
            generator: false,
            typeParameters: [],
          },
        }),
      ]
    })
    expect(checkIRIntegrity(ir)).toEqual([])
  })

  it("names both spellings by code point, since they render identically", () => {
    const ir = irWith((ir) => {
      ir.symbols = [
        makeSymbol("ts:src/a.ts#foo", { calls: [{ target: decomposed, line: 1, resolved: null }] }),
      ]
    })
    const message = violationsOf(ir, 19)[0]?.message ?? ""
    expect(message).toContain("U+0065 U+0301")
    expect(message).toContain("U+00E9")
  })

  it("leaves a non-NFC Symbol id to the id-shape check, which refuses it in its own right", () => {
    const ir = irWith((ir) => {
      ir.symbols = [makeSymbol(`ts:src/a.ts#${decomposed}`, { name: "foo" })]
    })
    expect(violationsOf(ir, 17)).toHaveLength(1)
    expect(violationsOf(ir, 19)).toEqual([])
  })

  it("reports a non-NFC Symbol.name here, because the id-shape check does not catch it", () => {
    const ir = irWith((ir) => {
      ir.symbols = [makeSymbol("ts:src/a.ts#foo", { name: decomposed })]
    })
    expect(violationsOf(ir, 17)).toEqual([])
    expect(violationsOf(ir, 19)[0]?.message).toContain("name")
  })

  it("refuses NFKC as a substitute: compatibility folding is not normalization here", () => {
    const ir = irWith((ir) => {
      ir.components = [component({ id: "a", name: "a", roots: ["apps/\uFB01le", "apps/\uFF21pp"] })]
    })
    expect(violationsOf(ir, 19)).toEqual([])
  })
})

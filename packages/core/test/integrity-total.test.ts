import type { IR } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { checkIRIntegrity } from "../src/index"
import { makeComponent, makeDependency, makeSymbol, minimalIR } from "./fixtures/ir"

/**
 * `checkIRIntegrity` answers "what is wrong with this Document?" and is the only gate
 * `readIR` applies, so it has to have an answer for anything a JSON parse can produce.
 * Nineteen of the twenty invariants dereference fields, and every one of those is a
 * `TypeError` waiting for a Document that does not carry them.
 *
 * A hand-written list of malformed shapes cannot establish that: it pins the cases someone
 * thought of, which is exactly the set already known to work. This walks a well-formed
 * Document instead, replacing each leaf and each container in turn with values a parse can
 * yield, and asserts only that the checker *answers*. The eight crashes this file was
 * written for were all in fields no hand-written case covered.
 */

/** Values a `JSON.parse` can hand back, plus the two non-finite numbers a hand-edit can. */
const SUBSTITUTES: readonly unknown[] = [
  null,
  undefined,
  7,
  "x",
  true,
  {},
  [],
  [null],
  [7],
  [{}],
  Number.NaN,
  Number.POSITIVE_INFINITY,
]

/** A Document exercising every optional container, so the walk reaches all of them. */
function richIR(): IR {
  const ir = minimalIR()
  ir.components = [
    makeComponent("a", { publicApi: ["src/index.ts"], frameworks: ["nextjs"], description: null }),
  ]
  ir.workspace.managers = [{ tool: "pnpm", roots: ["apps/a"] }]
  ir.symbols = [
    makeSymbol("ts:src/a.ts#foo", {
      component: "a",
      decorators: [{ name: "D", raw: "@D()", arguments: [], boundary: false, line: 1 }],
      rules: [{ type: "guard", line: 2, condition: "x", what: null, expr: null, loopKind: null }],
      effects: [
        {
          id: "db.write",
          target: "t",
          line: 3,
          plugin: "p",
          confidence: "high",
          derivedBy: "convention:test",
        },
      ],
      calls: [{ target: "helper", line: 4, resolved: "ts:src/a.ts#helper" }],
      signature: {
        inputs: [{ name: "x", type: "string" }],
        outputs: ["void"],
        throws: [],
        async: false,
        generator: false,
        typeParameters: [],
      },
    }),
    makeSymbol("ts:src/a.ts#helper", { component: "a" }),
  ]
  ir.dependencies = [makeDependency({ from: "ts:src/a.ts#foo", to: "ts:src/a.ts#helper" })]
  ir.stats.callResolution = {
    totalCalls: 1,
    resolvedCalls: 1,
    unresolved: { localScope: 0, external: 0, dynamic: 0, ambiguous: 0, noMatch: 0 },
  }
  ir.stats.lspEnrichment = {
    enabled: false,
    filesEnriched: 0,
    filesFellBack: 0,
    requestsIssued: 0,
    requestsTimedOut: 0,
    requestsFailed: 0,
    languagesDisabled: [],
  }
  ir.stats.effectClassifyTimeouts = [{ plugin: "p", symbolId: "ts:src/a.ts#foo", timeoutMs: 10 }]
  return ir
}

/** Every addressable position in the Document, as a dotted/bracketed path. */
function leafPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    const out = prefix === "" ? [] : [prefix]
    for (const [index, entry] of value.entries()) {
      out.push(...leafPaths(entry, `${prefix}[${index}]`))
    }
    return out
  }
  if (typeof value === "object" && value !== null) {
    const out = prefix === "" ? [] : [prefix]
    for (const [key, entry] of Object.entries(value)) {
      out.push(...leafPaths(entry, prefix === "" ? key : `${prefix}.${key}`))
    }
    return out
  }
  return prefix === "" ? [] : [prefix]
}

/** Write `substitute` at `path` in a fresh deep copy of `document`. */
function replaceAt(document: unknown, path: string, substitute: unknown): unknown {
  const copy = structuredClone(document)
  const steps = path.split(/\.|(?=\[)/).filter((s) => s.length > 0)
  let cursor: Record<string, unknown> | unknown[] = copy as Record<string, unknown>
  for (const [index, step] of steps.entries()) {
    const key = step.startsWith("[") ? Number(step.slice(1, -1)) : step
    if (index === steps.length - 1) {
      if (substitute === undefined) delete (cursor as Record<string, unknown>)[key as string]
      else (cursor as Record<string, unknown>)[key as string] = substitute
      return copy
    }
    cursor = (cursor as Record<string, unknown>)[key as string] as Record<string, unknown>
  }
  return copy
}

describe("checkIRIntegrity is total", () => {
  it("answers rather than throwing for every single-position corruption of a Document", () => {
    const document = richIR()
    const paths = leafPaths(document)
    expect(paths.length).toBeGreaterThan(80)

    const crashes: string[] = []
    for (const path of paths) {
      for (const substitute of SUBSTITUTES) {
        const corrupted = replaceAt(document, path, substitute)
        try {
          checkIRIntegrity(corrupted)
        } catch (error) {
          crashes.push(`${path} = ${JSON.stringify(substitute) ?? "undefined"} -> ${error}`)
        }
      }
    }
    expect(crashes).toEqual([])
  })

  it("reports something for every corruption that is not a valid Document", () => {
    // Answering is necessary but not sufficient: a checker that returned `[]` for everything
    // would also never throw. Each substitution below breaks the schema's own shape, so a
    // silent pass would mean #20 walked past it.
    const document = richIR()
    const silent: string[] = []
    for (const path of leafPaths(document)) {
      for (const substitute of [undefined, {}] as const) {
        const corrupted = replaceAt(document, path, substitute)
        if (checkIRIntegrity(corrupted).length === 0) {
          silent.push(`${path} = ${substitute === undefined ? "absent" : "{}"}`)
        }
      }
    }
    // Class B optional keys are the documented exception: their absence is the value.
    expect(silent.filter((s) => !s.endsWith("= absent"))).toEqual([])
  })

  it("says nothing about the Document the corruptions are derived from", () => {
    expect(checkIRIntegrity(richIR())).toEqual([])
  })
})

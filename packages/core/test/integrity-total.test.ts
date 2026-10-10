import { component, decorator, dependency, effect, makeIR, rule, sig } from "@aburi/test-support"
import type { IR } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { checkIRIntegrity } from "../src/index"
import { makeSymbol } from "./fixtures/ir"

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
  const ir = makeIR()
  ir.components = [
    component({
      id: "a",
      name: "a",
      publicApi: ["src/index.ts"],
      frameworks: ["nextjs"],
      description: null,
    }),
  ]
  ir.workspace.managers = [{ tool: "pnpm", roots: ["apps/a"] }]
  ir.symbols = [
    makeSymbol("ts:src/a.ts#foo", {
      component: "a",
      decorators: [decorator({ name: "D", line: 1 })],
      rules: [rule({ type: "guard", line: 2, condition: "x" })],
      effects: [effect({ id: "db.write", target: "t", plugin: "p", line: 3 })],
      calls: [{ target: "helper", line: 4, resolved: "ts:src/a.ts#helper" }],
      signature: sig({ inputs: [{ name: "x", type: "string" }] }),
    }),
    makeSymbol("ts:src/a.ts#helper", { component: "a" }),
  ]
  ir.dependencies = [dependency({ from: "ts:src/a.ts#foo", to: "ts:src/a.ts#helper", via: "call" })]
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
    hintsProduced: 0,
    hintsConsumed: 0,
    hintsRejected: {
      unparseableHover: 0,
      ownerClassNotFound: 0,
      memberNotFound: 0,
      kindMismatch: 0,
      targetDropped: 0,
    },
  }
  ir.stats.effectClassifyTimeouts = [{ plugin: "p", symbolId: "ts:src/a.ts#foo", timeoutMs: 10 }]
  return ir
}

function positionsOf(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    const out = prefix === "" ? [] : [prefix]
    for (const [index, entry] of value.entries()) {
      out.push(...positionsOf(entry, `${prefix}[${index}]`))
    }
    return out
  }
  if (typeof value === "object" && value !== null) {
    const out = prefix === "" ? [] : [prefix]
    for (const [key, entry] of Object.entries(value)) {
      out.push(...positionsOf(entry, prefix === "" ? key : `${prefix}.${key}`))
    }
    return out
  }
  return prefix === "" ? [] : [prefix]
}

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
    const paths = positionsOf(document)
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

  it("reports an object written at any position that holds something else", () => {
    const document = richIR()
    const silent = positionsOf(document).filter(
      (path) => checkIRIntegrity(replaceAt(document, path, {})).length === 0,
    )
    expect(silent).toEqual([])
  })

  it("says nothing about the Document the corruptions are derived from", () => {
    expect(checkIRIntegrity(richIR())).toEqual([])
  })
})

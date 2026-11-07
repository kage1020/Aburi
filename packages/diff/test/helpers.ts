import { logicFingerprint } from "@aburi/core"
import {
  changeLines,
  dependency,
  errorFrom,
  fp,
  guardedBody,
  makeIR,
  makeSymbol,
  sig,
  zeroFp,
} from "@aburi/test-support"
import type { Dependency, IR, Symbol as IRSymbol, SkippedFile } from "@aburi/types"
import { buildDiff, DiffError, type DiffInput, type SymbolPair } from "../src"

const IR_REF = { ref: "test", irSchema: "aburi.ir.v1.json" } as const

type BuiltDiff = ReturnType<typeof buildDiff>

export function diffOf(baseIR: IR, headIR: IR, extras: Partial<DiffInput> = {}): BuiltDiff {
  return buildDiff({ baseIR, headIR, base: IR_REF, head: IR_REF, ...extras })
}

export function refusalOf(baseIR: IR, headIR: IR): Promise<DiffError> {
  return errorFrom(DiffError, () => diffOf(baseIR, headIR))
}

export function diffSymbols(
  base: readonly IRSymbol[],
  head: readonly IRSymbol[],
  extras: Partial<DiffInput> = {},
): BuiltDiff {
  return diffOf(makeIR({ symbols: [...base] }), makeIR({ symbols: [...head] }), extras)
}

export function changesBetween(
  base: readonly IRSymbol[],
  head: readonly IRSymbol[],
  extras: Partial<DiffInput> = {},
): string[] {
  return changeLines(diffSymbols(base, head, extras).symbols)
}

/** Every pairing the diff reports, whatever its status, as `base name -> head name`. */
export function pairedNames(base: readonly IRSymbol[], head: readonly IRSymbol[]): string[] {
  return diffSymbols(base, head).symbols.flatMap((change) =>
    "before" in change ? [`${change.before.name} -> ${change.after.name}`] : [],
  )
}

export function stagePairNames(matched: readonly SymbolPair[]): string[] {
  return matched.map((pair) => `${pair.base.name} -> ${pair.head.name}`)
}

export function withSkipped(ir: IR, skipped: readonly SkippedFile[]): IR {
  return {
    ...ir,
    stats: {
      ...ir.stats,
      totalFiles: ir.stats.totalFiles + skipped.length,
      skippedFiles: [...skipped],
    },
  }
}

const ID_TO_USER = sig({ inputs: [{ name: "id", type: "string" }], outputs: ["User"] })

/** A top-level function at `file`, with a signature for stage 4 to score. */
export function fn(
  file: string,
  name: string,
  seed: string,
  overrides: Partial<IRSymbol> = {},
): IRSymbol {
  return makeSymbol({
    id: `ts:${file}#${name}`,
    name,
    signature: ID_TO_USER,
    fingerprint: fp(seed),
    ...overrides,
  })
}

export function method(
  file: string,
  name: string,
  seed: string,
  overrides: Partial<IRSymbol> = {},
): IRSymbol {
  return fn(file, name, seed, { kind: "method", ...overrides })
}

/** Logic that names nothing, so stage 3 reads the name alone, and no signature for stage 4. */
export function bare(file: string, name: string, kind: IRSymbol["kind"] = "class"): IRSymbol {
  const shape = makeSymbol({ id: `ts:${file}#${name}`, name, kind })
  return { ...shape, fingerprint: { ...fp("bare"), logic: logicFingerprint(shape) } }
}

/** A guard names something, so stage 3 pairs a lone method on its logic whatever its owner. */
export function guarded(file: string, name: string, logic: string): IRSymbol {
  return makeSymbol({
    id: `ts:${file}#${name}`,
    name,
    kind: "method",
    signature: sig(),
    rules: guardedBody(logic),
    fingerprint: { ...fp(logic), logic },
  })
}

export function dropped(file: string, name: string, kind: IRSymbol["kind"] = "class"): IRSymbol {
  return makeSymbol({
    id: `ts:${file}#${name}`,
    name,
    kind,
    dropped: true,
    dropReason: "size",
    fingerprint: zeroFp(),
  })
}

export function callEdge(
  from: string,
  to: string,
  overrides: Partial<Dependency> = {},
): Dependency {
  return dependency({ from, to, via: "call", ...overrides })
}

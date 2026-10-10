import { errorFrom, fp, makeIR, makeSymbol, sig, zeroFp } from "@aburi/test-support"
import type { IR, Symbol as IRSymbol, SkippedFile, SymbolChange } from "@aburi/types"
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

/** Each change as `status base -> head`, or `status id` when only one side holds it. */
export function changeLines(changes: readonly SymbolChange[]): string[] {
  return changes.map((change) =>
    "before" in change
      ? `${change.status} ${change.before.id} -> ${change.after.id}`
      : `${change.status} ${change.symbol.id}`,
  )
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

export function soleChange<S extends SymbolChange["status"]>(
  changes: readonly SymbolChange[],
  status: S,
): Extract<SymbolChange, { status: S }> {
  const found = changes.filter(
    (change): change is Extract<SymbolChange, { status: S }> => change.status === status,
  )
  const [only] = found
  if (only === undefined || found.length > 1) {
    throw new Error(`expected one ${status} change; got ${changeLines(changes).join(", ")}`)
  }
  return only
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

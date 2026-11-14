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

/**
 * The logic fingerprint the rules really hash to, which with none names nothing, so stage 3
 * reads the name alone; and no signature for stage 4.
 */
export function bare(
  file: string,
  name: string,
  kind: IRSymbol["kind"] = "class",
  rules: IRSymbol["rules"] = [],
): IRSymbol {
  const shape = makeSymbol({ id: `ts:${file}#${name}`, name, kind, rules })
  return { ...shape, fingerprint: { ...fp("bare"), logic: logicFingerprint(shape) } }
}

/** A guard names something, so stage 3 pairs a lone member on its logic whatever its owner. */
export function guarded(
  file: string,
  name: string,
  logic: string,
  kind: IRSymbol["kind"] = "method",
): IRSymbol {
  return makeSymbol({
    id: `ts:${file}#${name}`,
    name,
    kind,
    signature: sig(),
    rules: guardedBody(logic),
    fingerprint: { ...fp(logic), logic },
  })
}

export interface Revision {
  readonly base: readonly IRSymbol[]
  readonly head: readonly IRSymbol[]
}

export const RENDER = "aaaaaaaaaaa1"
export const PRINT = "aaaaaaaaaaa2"
const CHARGE = "aaaaaaaaaaa4"
const TOTAL = "aaaaaaaaaaa5"

/** Owners whose members paired, each in a shape that leaves the owner unpaired. */
export const UNSETTLED_OWNERS: Readonly<
  Record<"split" | "hoisted" | "renamed" | "nested" | "merged" | "joined", Revision>
> = {
  split: {
    base: [
      bare("src/old.ts", "Invoice"),
      guarded("src/old.ts", "Invoice.render", RENDER),
      guarded("src/old.ts", "Invoice.print", PRINT),
    ],
    head: [
      bare("src/new.ts", "Invoice"),
      bare("src/new.ts", "Printer"),
      guarded("src/new.ts", "Invoice.render", RENDER),
      guarded("src/new.ts", "Printer.print", PRINT),
    ],
  },
  hoisted: {
    base: [
      bare("src/old.ts", "Billing", "namespace"),
      guarded("src/old.ts", "Billing.total", TOTAL, "function"),
    ],
    head: [
      bare("src/new.ts", "Billing", "namespace"),
      guarded("src/new.ts", "total", TOTAL, "function"),
    ],
  },
  renamed: {
    base: [bare("src/old.ts", "Invoice"), guarded("src/old.ts", "Invoice.render", RENDER)],
    head: [bare("src/new.ts", "Receipt"), guarded("src/new.ts", "Receipt.render", RENDER)],
  },
  nested: {
    base: [bare("src/old.ts", "BillingInvoices"), method("src/old.ts", "BillingInvoices.run", "r")],
    head: [
      bare("src/new.ts", "Billing::Invoice"),
      method("src/new.ts", "Billing::Invoice.run", "r"),
    ],
  },
  merged: {
    base: [
      bare("src/a.ts", "Invoice"),
      guarded("src/a.ts", "Invoice.render", RENDER),
      bare("src/b.ts", "Invoice"),
      guarded("src/b.ts", "Invoice.print", PRINT),
    ],
    head: [
      bare("src/c.ts", "Invoice"),
      guarded("src/c.ts", "Invoice.render", RENDER),
      guarded("src/c.ts", "Invoice.print", PRINT),
    ],
  },
  joined: {
    base: [
      bare("src/old.ts", "Billing", "namespace"),
      guarded("src/old.ts", "Billing.charge", CHARGE, "function"),
      guarded("src/old.ts", "total", TOTAL, "function"),
    ],
    head: [
      bare("src/new.ts", "Billing", "namespace"),
      guarded("src/new.ts", "Billing.charge", CHARGE, "function"),
      guarded("src/new.ts", "Billing.total", TOTAL, "function"),
    ],
  },
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

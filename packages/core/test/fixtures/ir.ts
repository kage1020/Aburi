import { call, makeSymbol as makeSymbolRecord, zeroFp } from "@aburi/test-support"
import type { Symbol as IRSymbol } from "@aburi/types"

export type SymbolOverrides = Omit<Partial<IRSymbol>, "id" | "component" | "calls"> & {
  component?: string | null
  calls?: Array<{ target: string; line: number; resolved: string | null }>
}

/** A Symbol named after the part of `id` past the `#`, with a zero fingerprint. */
export function makeSymbol(id: string, overrides: SymbolOverrides = {}): IRSymbol {
  const { calls, ...rest } = overrides
  return makeSymbolRecord({
    id,
    name: id.split("#")[1] ?? "anonymous",
    fingerprint: zeroFp(),
    ...rest,
    calls: (calls ?? []).map(call),
  })
}

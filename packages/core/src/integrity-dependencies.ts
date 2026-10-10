import type { DependencyEndpoint, IR, Symbol as IRSymbol } from "@aburi/types"
import { CALL_SITE_KEY_SEPARATOR, callEdgeKey, dependencyKey } from "./call-site"
import type { IntegrityViolation } from "./errors"

/**
 * Looser than `isSymbolId`, so a malformed Symbol id is still checked as a Symbol id rather than
 * passed over as a Component id.
 */
const SYMBOL_ID_PATTERN = /^[a-z][a-z0-9]*:[^#]+#.+$/

export function checkDependencyEndpoints(ir: IR, out: IntegrityViolation[]): void {
  const symbolIds = new Set<string>(ir.symbols.map((s) => s.id))
  for (const dep of ir.dependencies) {
    for (const role of ["from", "to"] as const) {
      const endpoint = dep[role]
      if (looksLikeSymbolId(endpoint) && !symbolIds.has(endpoint)) {
        out.push({
          invariant: 4,
          subject: `dependencies[${role}=${endpoint}]`,
          message: `dependency ${role} looks like a Symbol id but does not match any declared Symbol`,
        })
      }
    }
  }
}

export function checkCallEdgeEndpoints(ir: IR, out: IntegrityViolation[]): void {
  const symbolsById = new Map<string, IRSymbol>(ir.symbols.map((s) => [s.id, s]))
  for (const dep of ir.dependencies) {
    if (dep.via !== "call") continue
    for (const role of ["from", "to"] as const) {
      const endpoint = dep[role]
      if (!looksLikeSymbolId(endpoint)) {
        out.push({
          invariant: 12,
          subject: `dependencies[${role}=${endpoint}]`,
          message: `via:"call" dependency ${role} must be a Symbol id, got "${endpoint}"`,
        })
        continue
      }
      const target = symbolsById.get(endpoint)
      if (target === undefined) {
        out.push({
          invariant: 12,
          subject: `dependencies[${role}=${endpoint}]`,
          message: `via:"call" dependency ${role} "${endpoint}" is not a declared Symbol`,
        })
        continue
      }
      if (target.dropped === true) {
        out.push({
          invariant: 12,
          subject: `dependencies[${role}=${endpoint}]`,
          message: `via:"call" dependency ${role} "${endpoint}" points at a dropped Symbol`,
        })
      }
    }
  }
}

export function checkDependencyTupleUniqueness(ir: IR, out: IntegrityViolation[]): void {
  const seen = new Set<string>()
  for (const dep of ir.dependencies) {
    const key = dependencyKey(dep.from, dep.to, dep.via)
    if (seen.has(key)) {
      out.push({
        invariant: 13,
        subject: `dependencies[from=${dep.from},to=${dep.to},via=${dep.via}]`,
        message: "duplicate (from, to, via) triple in dependencies[]",
      })
      continue
    }
    seen.add(key)
  }
}

export function checkCallGraphProjectionAgrees(ir: IR, out: IntegrityViolation[]): void {
  const expectedFromCalls = new Set<string>()
  for (const symbol of ir.symbols) {
    for (const call of symbol.calls) {
      if (call.resolved === null) continue
      expectedFromCalls.add(callEdgeKey(symbol.id, call.resolved))
    }
  }

  const foundInDeps = new Set<string>()
  for (const dep of ir.dependencies) {
    if (dep.via !== "call") continue
    foundInDeps.add(callEdgeKey(dep.from, dep.to))
  }

  for (const key of expectedFromCalls) {
    if (!foundInDeps.has(key)) {
      const [from, to] = key.split(CALL_SITE_KEY_SEPARATOR)
      out.push({
        invariant: 14,
        subject: `dependencies[from=${from},to=${to},via=call]`,
        message: `Symbol.calls[].resolved -> ${to} has no matching via:"call" Dependency`,
      })
    }
  }
  for (const key of foundInDeps) {
    if (!expectedFromCalls.has(key)) {
      const [from, to] = key.split(CALL_SITE_KEY_SEPARATOR)
      out.push({
        invariant: 14,
        subject: `symbols[id=${from}].calls[resolved=${to}]`,
        message: `via:"call" Dependency ${from} -> ${to} has no matching Symbol.calls[].resolved entry`,
      })
    }
  }
}

function looksLikeSymbolId(endpoint: DependencyEndpoint): boolean {
  return SYMBOL_ID_PATTERN.test(endpoint)
}

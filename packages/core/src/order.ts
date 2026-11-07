import type { DeclinedCall } from "@aburi/types"

export function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function compareBy<T>(key: (value: T) => string): (a: T, b: T) => number {
  return (a, b) => compareCodeUnit(key(a), key(b))
}

export function stringArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function compareDeclinedCalls(a: DeclinedCall, b: DeclinedCall): number {
  return (
    compareCodeUnit(a.symbolId, b.symbolId) ||
    a.line - b.line ||
    compareCodeUnit(a.target, b.target) ||
    compareCodeUnit(a.plugin, b.plugin)
  )
}

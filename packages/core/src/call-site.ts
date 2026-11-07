import type { ThisBinding } from "@aburi/types"

export const CALL_SITE_KEY_SEPARATOR = "\t"

export function dependencyKey(from: string, to: string, via: string): string {
  return [from, to, via].join(CALL_SITE_KEY_SEPARATOR)
}

export function callEdgeKey(from: string, to: string): string {
  return [from, to].join(CALL_SITE_KEY_SEPARATOR)
}

export function makeCallSiteKey(file: string, line: number, target: string): string {
  return [file, line, target].join(CALL_SITE_KEY_SEPARATOR)
}

export function receiverHead(target: string): string | undefined {
  return target.split(".").find((segment) => segment.length > 0)
}

/** Call-site keys by what `this` is where the call is written. */
export type ThisBindingSites = Readonly<Record<ThisBinding, ReadonlySet<string>>>

export type CallSiteBinding = readonly [key: string, binding: ThisBinding]

export const NO_THIS_BINDINGS: ThisBindingSites = { class: new Set(), instance: new Set() }

// One key can stand for calls written on both sides, which a hint keyed by it cannot tell apart.
export function thisBindingOfSite(sites: ThisBindingSites, key: string): ThisBinding | null {
  const onClass = sites.class.has(key)
  if (onClass === sites.instance.has(key)) return null
  return onClass ? "class" : "instance"
}

export function isThisBinding(value: unknown): value is ThisBinding {
  return value === "class" || value === "instance"
}

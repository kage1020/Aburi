import type { ComponentId, SliceId, SymbolId } from "@aburi/types"

/**
 * Id branding for CLI test fixtures.
 *
 * Fixtures are one of the documented boundary layers where an id is asserted rather than
 * constructed (ir-schema.md §3.5): these files hand-write whole IR documents, including ones
 * the producers could never emit, so routing them through `makeSymbolId` would make the
 * negative cases unwritable. Production code has no such escape — it reaches a branded id
 * only through the constructors and guards in `@aburi/core`.
 */
export function symbolId(raw: string): SymbolId {
  return raw as SymbolId
}

/** Component-id counterpart of `symbolId`, same rationale. */
export function componentId(raw: string): ComponentId {
  return raw as ComponentId
}

/** Slice-id counterpart of `symbolId`, same rationale. */
export function sliceId(raw: string): SliceId {
  return raw as SliceId
}

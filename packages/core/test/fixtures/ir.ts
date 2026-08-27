import type {
  Component,
  ComponentId,
  Dependency,
  DependencyEndpoint,
  IR,
  Symbol as IRSymbol,
  SymbolId,
} from "@aburi/types"
import { makeLanguageId } from "../../src/id"

const SCHEMA = "https://aburi.kage1020.com/schema/aburi.ir.v1.json"

/**
 * Brand a literal as a Symbol id. Fixtures are one of the boundary layers where an id is
 * asserted rather than constructed: a case that wants a *malformed* id has to be able to
 * write one, so routing these through `makeSymbolId` would make the negative tests
 * unwritable. Production code never has this option — it goes through `makeSymbolId` /
 * `trySymbolId`, which check.
 */
export function symbolId(raw: string): SymbolId {
  return raw as SymbolId
}

/** Component-id counterpart of `symbolId`, with the same rationale. */
export function componentId(raw: string): ComponentId {
  return raw as ComponentId
}

/**
 * Dependency endpoints hold either id kind and are told apart by shape (ir-schema.md §11).
 * Fixtures deliberately feed malformed endpoints to the invariants that exist to catch them,
 * so this brands whatever the case wrote rather than discriminating.
 */
export function endpoint(raw: string): DependencyEndpoint {
  return raw as DependencyEndpoint
}

export function makeComponent(
  id: string,
  overrides: Omit<Partial<Component>, "id"> = {},
): Component {
  return {
    id: componentId(id),
    name: id,
    roots: [`apps/${id}`],
    languages: [makeLanguageId("ts")],
    ...overrides,
  }
}

export function makeDependency(
  over: Omit<Partial<Dependency>, "from" | "to"> & { from: string; to: string },
): Dependency {
  const { from, to, ...rest } = over
  return {
    from: endpoint(from),
    to: endpoint(to),
    via: "call",
    direction: "outbound",
    effect: null,
    ...rest,
  }
}

export function minimalIR(): IR {
  return {
    $schema: SCHEMA,
    generator: {
      name: "aburi",
      version: "0.0.0",
      plugins: [],
    },
    workspace: {
      root: ".",
      managers: [],
      languages: [makeLanguageId("ts")],
    },
    components: [],
    symbols: [],
    dependencies: [],
    stats: {
      totalFiles: 0,
      parsedFiles: 0,
      keptSymbols: 0,
      droppedSymbols: 0,
      effectPropagation: {
        sccCount: 0,
        maxSccSize: 0,
        propagatedEffectCount: 0,
        symbolsWithPropagatedEffects: 0,
      },
    },
  }
}

/**
 * Overrides accepted by `makeSymbol`. The id-shaped fields are widened back to `string` so a
 * case can keep writing `component: "billing"` or `resolved: "ts:src/x.ts#f"` inline; the
 * builder brands them in one place, which is the whole point of a fixture boundary.
 */
export type SymbolOverrides = Omit<Partial<IRSymbol>, "id" | "component" | "calls"> & {
  component?: string | null
  calls?: Array<{ target: string; line: number; resolved: string | null }>
}

export function makeSymbol(id: string, overrides: SymbolOverrides = {}): IRSymbol {
  const { component, calls, ...rest } = overrides
  return {
    id: symbolId(id),
    kind: "function",
    extKind: null,
    name: id.split("#")[1] ?? "anonymous",
    language: makeLanguageId("ts"),
    component: component === undefined || component === null ? null : componentId(component),
    visibility: "public",
    decorators: [],
    signature: null,
    rules: [],
    effects: [],
    calls: (calls ?? []).map((c) => ({
      target: c.target,
      line: c.line,
      resolved: c.resolved === null ? null : symbolId(c.resolved),
    })),
    source: {
      file: id.split(":")[1]?.split("#")[0] ?? "src/a.ts",
      startLine: 1,
      endLine: 1,
      startColumn: null,
      endColumn: null,
    },
    fingerprint: { api: "0".repeat(12), logic: "0".repeat(12), syntax: "0".repeat(12) },
    confidence: "high",
    derivedBy: [],
    dropped: false,
    dropReason: null,
    ...rest,
  }
}

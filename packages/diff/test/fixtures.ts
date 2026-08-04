import { makeLanguageId } from "@aburi/core"
import type {
  Call,
  Component,
  ComponentId,
  Decorator,
  Dependency,
  DependencyEndpoint,
  Effect,
  EffectId,
  Fingerprint,
  IR,
  Symbol as IRSymbol,
  Rule,
  Signature,
  SliceId,
  SymbolId,
} from "@aburi/types"

/**
 * Brand a literal as a Symbol id. Fixtures are one of the boundary layers where an id is
 * asserted rather than constructed: several cases here feed *malformed* ids to the code
 * that exists to reject them, which routing through `makeSymbolId` would make unwritable.
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

/** Dependency endpoints hold either id kind and are told apart by shape (ir-schema.md §11). */
export function endpoint(raw: string): DependencyEndpoint {
  return raw as DependencyEndpoint
}

/**
 * Compact IR builder for diff tests. Every field carries a schema-satisfying default so
 * cases only spell out what they intend to change. The id-shaped fields are widened back to
 * `string` so cases keep writing literals; the branding happens here, once.
 */
export function makeSymbol(
  overrides: Omit<Partial<IRSymbol>, "id" | "component"> & {
    id: string
    name: string
    component?: string | null
  },
): IRSymbol {
  return {
    id: symbolId(overrides.id),
    kind: overrides.kind ?? "function",
    extKind: overrides.extKind ?? null,
    name: overrides.name,
    language: overrides.language ?? makeLanguageId("ts"),
    component:
      overrides.component === undefined || overrides.component === null
        ? null
        : componentId(overrides.component),
    visibility: overrides.visibility ?? "public",
    decorators: overrides.decorators ?? [],
    signature: overrides.signature ?? null,
    rules: overrides.rules ?? [],
    effects: overrides.effects ?? [],
    calls: overrides.calls ?? [],
    source: overrides.source ?? {
      file: filePartOf(overrides.id),
      startLine: 1,
      endLine: 10,
      startColumn: null,
      endColumn: null,
    },
    fingerprint: overrides.fingerprint ?? fp("aaa"),
    confidence: overrides.confidence ?? "high",
    derivedBy: overrides.derivedBy ?? [],
    dropped: overrides.dropped ?? false,
    dropReason: overrides.dropReason ?? null,
  }
}

export function fp(seed: string): Fingerprint {
  const pad = (s: string) => s.padStart(12, "0").slice(0, 12)
  return {
    api: pad(`api-${seed}`),
    logic: pad(`log-${seed}`),
    syntax: pad(`syn-${seed}`),
  }
}

export function zeroFp(): Fingerprint {
  return { api: "000000000000", logic: "000000000000", syntax: "000000000000" }
}

export function sig(overrides: Partial<Signature> = {}): Signature {
  return {
    inputs: overrides.inputs ?? [],
    outputs: overrides.outputs ?? ["void"],
    throws: overrides.throws ?? [],
    async: overrides.async ?? false,
    generator: overrides.generator ?? false,
    typeParameters: overrides.typeParameters ?? [],
  }
}

export function decorator(overrides: Partial<Decorator> & { name: string }): Decorator {
  return {
    name: overrides.name,
    raw: overrides.raw ?? `@${overrides.name}()`,
    arguments: overrides.arguments ?? [],
    boundary: overrides.boundary ?? false,
    line: overrides.line ?? 1,
  }
}

export function effect(
  overrides: Omit<Partial<Effect>, "derivedFrom"> & {
    id: EffectId
    target: string
    plugin: string
    derivedFrom?: string[]
  },
): Effect {
  const base: Effect = {
    id: overrides.id,
    target: overrides.target,
    line: overrides.line ?? 1,
    plugin: overrides.plugin,
    confidence: overrides.confidence ?? "high",
    derivedBy: overrides.derivedBy ?? "convention:test",
  }
  if (overrides.propagated !== undefined) base.propagated = overrides.propagated
  if (overrides.derivedFrom !== undefined) base.derivedFrom = overrides.derivedFrom.map(symbolId)
  return base
}

export function call(
  overrides: Omit<Partial<Call>, "resolved"> & { target: string; resolved?: string | null },
): Call {
  return {
    target: overrides.target,
    line: overrides.line ?? 1,
    resolved:
      overrides.resolved === undefined || overrides.resolved === null
        ? null
        : symbolId(overrides.resolved),
  }
}

export function rule(overrides: Partial<Rule> & { type: Rule["type"] }): Rule {
  return {
    type: overrides.type,
    line: overrides.line ?? 1,
    condition: overrides.condition ?? null,
    what: overrides.what ?? null,
    expr: overrides.expr ?? null,
    loopKind: overrides.loopKind ?? null,
  }
}

export function component(
  overrides: Omit<Partial<Component>, "id"> & { id: string; name: string },
): Component {
  return {
    id: componentId(overrides.id),
    name: overrides.name,
    roots: overrides.roots ?? [`apps/${overrides.id}`],
    publicApi: overrides.publicApi ?? [],
    languages: overrides.languages ?? [makeLanguageId("ts")],
    frameworks: overrides.frameworks ?? [],
    description: overrides.description ?? null,
  }
}

export function dependency(
  overrides: Omit<Partial<Dependency>, "from" | "to"> & { from: string; to: string },
): Dependency {
  return {
    from: endpoint(overrides.from),
    to: endpoint(overrides.to),
    via: overrides.via ?? "import",
    direction: overrides.direction ?? "outbound",
    effect: overrides.effect ?? null,
  }
}

export function makeIR(overrides: Partial<IR> & { symbols?: IRSymbol[] } = {}): IR {
  return {
    $schema: overrides.$schema ?? "https://aburi.dev/schema/aburi.ir.v1.json",
    generator: overrides.generator ?? {
      name: "aburi",
      version: "0.0.0",
      plugins: [],
    },
    workspace: overrides.workspace ?? {
      root: ".",
      managers: [],
      languages: [makeLanguageId("ts")],
    },
    components: overrides.components ?? [],
    symbols: overrides.symbols ?? [],
    dependencies: overrides.dependencies ?? [],
    stats: overrides.stats ?? {
      totalFiles: 0,
      parsedFiles: 0,
      keptSymbols: overrides.symbols?.filter((s) => !s.dropped).length ?? 0,
      droppedSymbols: overrides.symbols?.filter((s) => s.dropped).length ?? 0,
      effectPropagation: {
        sccCount: 0,
        maxSccSize: 0,
        propagatedEffectCount: 0,
        symbolsWithPropagatedEffects: 0,
      },
    },
  }
}

function filePartOf(raw: string): string {
  const colon = raw.indexOf(":")
  const hash = raw.indexOf("#")
  if (colon < 0 || hash < 0) return "src/index.ts"
  return raw.slice(colon + 1, hash)
}

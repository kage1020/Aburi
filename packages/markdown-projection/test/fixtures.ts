import type {
  Call,
  Component,
  Decorator,
  Dependency,
  DiffResult,
  Effect,
  EffectId,
  Fingerprint,
  IR,
  Symbol as IRSymbol,
  Rule,
  Signature,
  Summary,
} from "@aburi/types"

/** Compact IR builders reused across every test file. */

export function makeSymbol(overrides: Partial<IRSymbol> & { id: string; name: string }): IRSymbol {
  return {
    id: overrides.id,
    kind: overrides.kind ?? "function",
    extKind: overrides.extKind ?? null,
    name: overrides.name,
    language: overrides.language ?? "ts",
    component: overrides.component ?? null,
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

export function decorator(overrides: Partial<Decorator> & { name: string }): Decorator {
  return {
    name: overrides.name,
    raw: overrides.raw ?? `${overrides.name}()`,
    arguments: overrides.arguments ?? [],
    boundary: overrides.boundary ?? false,
    line: overrides.line ?? 1,
  }
}

export function effect(
  overrides: Partial<Effect> & { id: EffectId; target: string; plugin: string },
): Effect {
  return {
    id: overrides.id,
    target: overrides.target,
    line: overrides.line ?? 1,
    plugin: overrides.plugin,
    confidence: overrides.confidence ?? "high",
  }
}

export function call(overrides: Partial<Call> & { target: string }): Call {
  return {
    target: overrides.target,
    line: overrides.line ?? 1,
    resolved: overrides.resolved ?? null,
  }
}

export function component(overrides: Partial<Component> & { id: string; name: string }): Component {
  return {
    id: overrides.id,
    name: overrides.name,
    roots: overrides.roots ?? [`apps/${overrides.id}`],
    publicApi: overrides.publicApi ?? [],
    languages: overrides.languages ?? ["ts"],
    frameworks: overrides.frameworks ?? [],
    description: overrides.description ?? null,
  }
}

export function dependency(
  overrides: Partial<Dependency> & { from: string; to: string },
): Dependency {
  return {
    from: overrides.from,
    to: overrides.to,
    via: overrides.via ?? "import",
    direction: overrides.direction ?? "outbound",
    effect: overrides.effect ?? null,
  }
}

export function makeIR(overrides: Partial<IR> & { symbols?: IRSymbol[] } = {}): IR {
  return {
    $schema: overrides.$schema ?? "https://aburi.dev/schema/aburi.ir.v1.json",
    generator: overrides.generator ?? { name: "aburi", version: "0.0.0", plugins: [] },
    workspace: overrides.workspace ?? { root: ".", managers: [], languages: ["ts"] },
    components: overrides.components ?? [],
    symbols: overrides.symbols ?? [],
    dependencies: overrides.dependencies ?? [],
    stats: overrides.stats ?? {
      totalFiles: 0,
      parsedFiles: 0,
      keptSymbols: overrides.symbols?.filter((s) => !s.dropped).length ?? 0,
      droppedSymbols: overrides.symbols?.filter((s) => s.dropped).length ?? 0,
    },
  }
}

export function emptySummary(): Summary {
  return {
    added: 0,
    removed: 0,
    moved: 0,
    movedChanged: 0,
    changed: 0,
    droppedToggled: 0,
    unchanged: 0,
    droppedAdded: 0,
    droppedRemoved: 0,
    componentsAdded: 0,
    componentsRemoved: 0,
    componentsChanged: 0,
    depsAdded: 0,
    depsRemoved: 0,
  }
}

export function makeDiff(overrides: Partial<DiffResult> = {}): DiffResult {
  return {
    $schema: "https://aburi.dev/schema/aburi.diff.v1.json",
    generator: { name: "aburi", version: "0.0.0" },
    base: { ref: "main", irSchema: "aburi.ir.v1.json" },
    head: { ref: "HEAD", irSchema: "aburi.ir.v1.json" },
    summary: overrides.summary ?? emptySummary(),
    symbols: overrides.symbols ?? [],
    components: overrides.components ?? { added: [], removed: [], changed: [] },
    dependencies: overrides.dependencies ?? { added: [], removed: [] },
    ...overrides,
  }
}

function filePartOf(symbolId: string): string {
  const colon = symbolId.indexOf(":")
  const hash = symbolId.indexOf("#")
  if (colon < 0 || hash < 0) return "src/index.ts"
  return symbolId.slice(colon + 1, hash)
}

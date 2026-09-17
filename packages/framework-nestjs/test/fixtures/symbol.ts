import { makeExtractionCtx } from "@aburi/test-support"
import type { Decorator, FrameworkClassifyContext, ImportEdge } from "@aburi/types"

export { makeCandidate } from "@aburi/test-support"

export interface CtxOverrides {
  path?: string
  content?: string
  imports?: readonly ImportEdge[]
}

export function makeCtx(overrides: CtxOverrides = {}): FrameworkClassifyContext {
  return {
    ...makeExtractionCtx(overrides.path ?? "src/a.ts", overrides.content ?? ""),
    imports: overrides.imports ?? [],
  }
}

/**
 * A static named-import edge, the shape `@aburi/lang-typescript` emits. `symbols` entries
 * follow the `ImportEdge.symbols` wire format, so an aliased import is written the way the
 * source wrote it: `"Controller as Ctrl"`.
 */
export function makeImport(source: string, symbols: string[] | "*", line = 1): ImportEdge {
  return { source, symbols, line, dynamic: false }
}

export function makeDecorator(name: string, args: string[] = [], line = 1): Decorator {
  const argList = args.join(", ")
  return {
    name,
    raw: args.length > 0 ? `${name}(${argList})` : name,
    arguments: args,
    boundary: false,
    line,
  }
}

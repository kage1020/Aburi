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

export function makeQualifiedDecorator(
  qualifier: string,
  name: string,
  args: string[] = [],
  line = 1,
): Decorator {
  const bare = makeDecorator(name, args, line)
  return { ...bare, qualifier, raw: `${qualifier}.${bare.raw}` }
}

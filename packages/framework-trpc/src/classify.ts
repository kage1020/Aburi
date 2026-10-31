import {
  asSyntaxNode,
  declaratorValue,
  lastQnameSegment,
  type SyntaxNode,
  unwrapValue,
} from "@aburi/core"
import type {
  FrameworkClassifyContext,
  OpaqueAstNode,
  SymbolCandidate,
  SymbolClassification,
} from "@aburi/types"
import { type Chain, readChain, writtenArguments } from "./chain"
import { TRPC_DERIVED_BY_PREFIX, type TrpcExtKind } from "./ext-kinds"
import { hasTrpcServerImport } from "./imports"

type TrpcRole = TrpcExtKind extends `${typeof TRPC_DERIVED_BY_PREFIX}:${infer Role}` ? Role : never

const ROUTER_FACTORIES: ReadonlySet<string> = new Set(["router", "createTRPCRouter"])
const PROCEDURE_TERMINALS: ReadonlySet<string> = new Set(["query", "mutation", "subscription"])
const BUILDER_STEPS: ReadonlySet<string> = new Set(["use", "input", "output", "meta", "concat"])
const RESOLVER_TYPES: ReadonlySet<string> = new Set([
  "arrow_function",
  "function_expression",
  "identifier",
  "member_expression",
])

export function classifyTrpcSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: FrameworkClassifyContext,
): SymbolClassification | null {
  if (symbol.kind !== "const") return null
  const statement = asSyntaxNode(symbol.fullNode)
  if (statement === null) return null
  // `lastQnameSegment` throws on a broken qname; that is a language-plugin bug not to swallow.
  const initializer = declaratorValue(statement, lastQnameSegment(symbol.name))
  const chain = initializer === null ? null : readChain(initializer)
  const role = chain === null ? null : roleOf(chain)
  if (chain === null || role === null) return null
  return {
    extKind: `${TRPC_DERIVED_BY_PREFIX}:${role}` satisfies TrpcExtKind,
    derivedBy: `${TRPC_DERIVED_BY_PREFIX}:${role}:${chain.name}`,
    // The names are tRPC's conventions rather than its exports, so only the import makes them tRPC's.
    confidence: hasTrpcServerImport(ctx.imports) ? "high" : "medium",
  }
}

function roleOf(chain: Chain): TrpcRole | null {
  const { call, leaf } = chain
  if (call === null) return leaf === "procedure" ? "base-procedure" : null
  const args = writtenArguments(call)
  if (leaf === "create") return chain.root === "initTRPC" ? "instance" : null
  if (ROUTER_FACTORIES.has(leaf)) {
    const [only, ...rest] = args
    return only !== undefined && rest.length === 0 && unwrapValue(only).type === "object"
      ? "router"
      : null
  }
  if (leaf === "mergeRouters") return args.length > 0 ? "router" : null
  if (leaf === "middleware") return isResolver(args) ? "middleware" : null
  if (!buildsOnProcedure(chain)) return null
  if (PROCEDURE_TERMINALS.has(leaf)) return isResolver(args) ? "procedure" : null
  return BUILDER_STEPS.has(leaf) ? "base-procedure" : null
}

function buildsOnProcedure(chain: Chain): boolean {
  return chain.path.includes("procedure") || /(^p|P)rocedure$/.test(chain.root)
}

function isResolver(args: readonly SyntaxNode[]): boolean {
  const [only, ...rest] = args
  return only !== undefined && rest.length === 0 && RESOLVER_TYPES.has(unwrapValue(only).type)
}

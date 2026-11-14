import {
  asSyntaxNode,
  calleeName,
  chainCalls,
  declaratorValue,
  lastQnameSegment,
  middlewareNames,
  type SyntaxNode,
  unwrapValue,
  writtenChildren,
} from "@aburi/core"
import {
  COMPUTED_TARGET_SEGMENT,
  type FrameworkClassifyContext,
  type OpaqueAstNode,
  type SymbolCandidate,
  type SymbolClassification,
} from "@aburi/types"
import { type Chain, readChain } from "./chain"
import { TRPC_DERIVED_BY_PREFIX, type TrpcExtKind } from "./ext-kinds"
import { hasTrpcServerImport } from "./imports"

type TrpcRole = TrpcExtKind extends `${typeof TRPC_DERIVED_BY_PREFIX}:${infer Role}` ? Role : never

const ROUTER_FACTORIES: ReadonlySet<string> = new Set(["router", "createTRPCRouter"])
const PROCEDURE_TERMINALS: ReadonlySet<string> = new Set(["query", "mutation", "subscription"])
const BUILDER_STEPS: ReadonlySet<string> = new Set(["use", "input", "output", "meta", "concat"])
// `concat` hands over another builder, whose middleware runs where the call is written.
const MIDDLEWARE_STEPS: ReadonlySet<string> = new Set(["use", "concat"])
const RESOLVER_TYPES: ReadonlySet<string> = new Set([
  "arrow_function",
  "function_expression",
  "generator_function",
  "identifier",
  "member_expression",
  "call_expression",
])
// tRPC's documentation and create-t3-app name a base procedure `procedure` or `…Procedure`.
const PROCEDURE_NAME = /(^p|P)rocedure$/

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
  const importsTrpc = hasTrpcServerImport(ctx.imports)
  const role = chain === null ? null : roleOf(chain, importsTrpc)
  if (chain === null || role === null) return null
  const middleware = BUILDS_A_PROCEDURE.has(role) ? chainMiddleware(chain.call) : []
  return {
    extKind: `${TRPC_DERIVED_BY_PREFIX}:${role}` satisfies TrpcExtKind,
    derivedBy: `${TRPC_DERIVED_BY_PREFIX}:${role}:${chain.name}`,
    // Most of these names are tRPC's conventions rather than its exports, so only the import
    // makes them tRPC's.
    confidence: importsTrpc ? "high" : "medium",
    ...(middleware.length > 0 ? { middleware } : {}),
  }
}

const BUILDS_A_PROCEDURE: ReadonlySet<TrpcRole> = new Set(["procedure", "base-procedure"])

function chainMiddleware(call: SyntaxNode | null): string[] {
  if (call === null) return []
  const steps = chainCalls(call)
    .toReversed()
    .filter((step) => MIDDLEWARE_STEPS.has(calleeName(step)?.leaf ?? ""))
  return middlewareNames(steps.flatMap(argumentsOf))
}

function roleOf(chain: Chain, importsTrpc: boolean): TrpcRole | null {
  const { call, leaf } = chain
  // `procedure` is a domain word as well (`form.procedure`), and a bare read says nothing more,
  // so it is taken only off a plain name in the file that creates tRPC's instance.
  if (call === null) {
    const instanceRead =
      leaf === "procedure" && chain.path.length === 0 && isInstanceName(chain.root)
    return instanceRead && importsTrpc ? "base-procedure" : null
  }
  const args = argumentsOf(call)
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
  const readOffRoot = chain.path.at(-1) === "procedure" && isInstanceName(chain.root)
  return readOffRoot || PROCEDURE_NAME.test(chain.root)
}

// tRPC's instance is held under a plain name (`t`), never `this` or an expression.
function isInstanceName(root: string): boolean {
  return root !== "this" && root !== COMPUTED_TARGET_SEGMENT
}

// A tagged template's `arguments` is the template itself, which hands over no resolver.
function argumentsOf(call: SyntaxNode): SyntaxNode[] {
  const list = call.childForFieldName("arguments")
  return list?.type === "arguments" ? writtenChildren(list) : []
}

function isResolver(args: readonly SyntaxNode[]): boolean {
  const [only, ...rest] = args
  return only !== undefined && rest.length === 0 && RESOLVER_TYPES.has(unwrapValue(only).type)
}

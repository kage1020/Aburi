import { assertNonEmptySegments, type PluginInputOrigin } from "@aburi/plugin-registry/plugin-input"
import type { CallCandidate, ClassifyContext, EffectClassification } from "@aburi/types"
import { EFFECTS_TRPC_DERIVED_BY_PREFIX, EFFECTS_TRPC_PLUGIN_NAME } from "./constants"
import { hasTrpcClientImport, hasTrpcServerImport } from "./imports"
import {
  isTrpcMutationTerminal,
  isTrpcQueryTerminal,
  isTrpcSubscriptionTerminal,
  type TrpcQueryTerminal,
} from "./methods"

const SERVER_AMBIGUOUS_TERMINAL: TrpcQueryTerminal = "query"

const MIN_CLIENT_SEGMENTS = 3

export function classifyTrpcCall(
  call: CallCandidate,
  ctx: ClassifyContext,
): EffectClassification | null {
  const origin: PluginInputOrigin = { plugin: EFFECTS_TRPC_PLUGIN_NAME, filePath: ctx.file.path }

  const { segments, last: terminal } = assertNonEmptySegments(call.target, origin)

  if (!hasTrpcClientImport(ctx.file.imports, ctx.file.path)) return null

  const clientPath = segments[0] === "this" ? segments.slice(1) : segments
  if (clientPath.length < MIN_CLIENT_SEGMENTS) return null

  if (
    terminal === SERVER_AMBIGUOUS_TERMINAL &&
    hasTrpcServerImport(ctx.file.imports, ctx.file.path)
  )
    return null

  const family = terminalFamily(terminal)
  if (family === null) return null

  const procedurePath = clientPath.slice(1, -1).join(".")

  return {
    effectId: "network.rpc",
    confidence: call.dynamicReceiver === true ? "medium" : "high",
    derivedBy: `${EFFECTS_TRPC_DERIVED_BY_PREFIX}:${family}:${procedurePath}`,
  }
}

function terminalFamily(terminal: string): "query" | "mutation" | "subscription" | null {
  if (isTrpcQueryTerminal(terminal)) return "query"
  if (isTrpcMutationTerminal(terminal)) return "mutation"
  if (isTrpcSubscriptionTerminal(terminal)) return "subscription"
  return null
}

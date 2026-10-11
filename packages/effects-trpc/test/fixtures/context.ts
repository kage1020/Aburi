import { importEdge } from "@aburi/test-support"
import type { ImportEdge } from "@aburi/types"

export function makeTrpcClientImport(): ImportEdge {
  return importEdge({ source: "@trpc/client", symbols: ["createTRPCClient"] })
}

export function makeTrpcServerImport(): ImportEdge {
  return importEdge({ source: "@trpc/server", symbols: ["initTRPC"] })
}

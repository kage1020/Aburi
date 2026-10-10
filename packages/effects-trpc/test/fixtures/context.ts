import type { ImportEdge } from "@aburi/types"

export function makeTrpcClientImport(): ImportEdge {
  return { source: "@trpc/client", symbols: ["createTRPCClient"], line: 1, dynamic: false }
}

export function makeTrpcServerImport(): ImportEdge {
  return { source: "@trpc/server", symbols: ["initTRPC"], line: 1, dynamic: false }
}

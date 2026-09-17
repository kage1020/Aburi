import type { ImportEdge } from "@aburi/types"

/** Vanilla client import — the most common client-side gate signal. */
export function makeTrpcClientImport(source = "@trpc/client"): ImportEdge {
  return { source, symbols: ["createTRPCClient"], line: 1, dynamic: false }
}

/** Router-side import — flips the server gate, suppressing the `query` terminal. */
export function makeTrpcServerImport(source = "@trpc/server"): ImportEdge {
  return { source, symbols: ["initTRPC"], line: 1, dynamic: false }
}

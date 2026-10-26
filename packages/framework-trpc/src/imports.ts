import type { ImportEdge } from "@aburi/types"

const TRPC_SERVER_MODULE = "@trpc/server"

export function hasTrpcServerImport(imports: readonly ImportEdge[]): boolean {
  return imports.some(
    ({ source }) => source === TRPC_SERVER_MODULE || source.startsWith(`${TRPC_SERVER_MODULE}/`),
  )
}

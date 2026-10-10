import { importEdge } from "@aburi/test-support"
import type { ImportEdge } from "@aburi/types"

export function makePrismaImport(): ImportEdge {
  return importEdge({ source: "@prisma/client", symbols: ["PrismaClient"] })
}

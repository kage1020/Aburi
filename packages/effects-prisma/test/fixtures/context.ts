import type { ImportEdge } from "@aburi/types"

export function makePrismaImport(): ImportEdge {
  return { source: "@prisma/client", symbols: ["PrismaClient"], line: 1, dynamic: false }
}

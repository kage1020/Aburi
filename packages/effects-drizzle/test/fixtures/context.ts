import { importEdge } from "@aburi/test-support"
import type { ImportEdge } from "@aburi/types"

export function makeDrizzleImport(): ImportEdge {
  return importEdge({ source: "drizzle-orm", symbols: ["sql"] })
}

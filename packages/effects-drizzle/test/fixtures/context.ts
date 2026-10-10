import type { ImportEdge } from "@aburi/types"

export function makeDrizzleImport(): ImportEdge {
  return { source: "drizzle-orm", symbols: ["sql"], line: 1, dynamic: false }
}

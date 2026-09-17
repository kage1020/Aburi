import type { ImportEdge } from "@aburi/types"

export function makeDrizzleImport(source = "drizzle-orm"): ImportEdge {
  return { source, symbols: ["sql"], line: 1, dynamic: false }
}

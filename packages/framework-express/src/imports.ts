import type { ExtractionContext, ImportEdge } from "@aburi/types"

/**
 * Extract observed import edges from the extraction context. Framework classifiers receive
 * an `ExtractionContext` whose `file` carries the raw source, not the parsed import list —
 * so we fall back to a lightweight scan of the top of the file for `import` / `require`
 * statements referencing "express". This is deliberately conservative: a false negative
 * downgrades confidence, not extKind.
 */
export function hasExpressImport(ctx: ExtractionContext): boolean {
  const content = ctx.file.content
  if (containsExpressImportSpecifier(content)) return true
  return false
}

const EXPRESS_IMPORT_PATTERNS: RegExp[] = [
  // `import express from "express"` / `import * as express from 'express'`
  /import\s+[^;'"\n]*\s+from\s+['"]express['"]/,
  // `import "express"` (side-effect) / dynamic `import('express')`
  /import\s*\(?\s*['"]express['"]/,
  // CommonJS `require("express")`
  /require\s*\(\s*['"]express['"]\s*\)/,
]

function containsExpressImportSpecifier(source: string): boolean {
  for (const pattern of EXPRESS_IMPORT_PATTERNS) {
    if (pattern.test(source)) return true
  }
  return false
}

/**
 * Provided for callers who already parsed the import list (e.g. tests using a synthetic
 * `ImportEdge[]`). The runtime path uses `hasExpressImport` above.
 */
export function importListMentionsExpress(imports: readonly ImportEdge[]): boolean {
  for (const edge of imports) {
    if (edge.source === "express") return true
  }
  return false
}

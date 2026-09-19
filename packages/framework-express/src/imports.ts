import type { ExtractionContext, ImportEdge } from "@aburi/types"

/**
 * Scan the raw source for an `import` / `require` of "express"; the context carries no
 * parsed import list. Conservative on purpose: a miss downgrades confidence, not extKind.
 */
export function hasExpressImport(ctx: ExtractionContext): boolean {
  return EXPRESS_IMPORT_PATTERNS.some((pattern) => pattern.test(ctx.file.content))
}

const EXPRESS_IMPORT_PATTERNS: RegExp[] = [
  // `import express from "express"` / `import * as express from 'express'`
  /import\s+[^;'"\n]*\s+from\s+['"]express['"]/,
  // `import "express"` (side-effect) / dynamic `import('express')`
  /import\s*\(?\s*['"]express['"]/,
  // CommonJS `require("express")`
  /require\s*\(\s*['"]express['"]\s*\)/,
]

/** For callers that already hold a parsed `ImportEdge[]`; the runtime path is `hasExpressImport`. */
export function importListMentionsExpress(imports: readonly ImportEdge[]): boolean {
  return imports.some((edge) => edge.source === "express")
}

import type { ImportEdge } from "@aburi/types"

/**
 * npm packages that expose a `PrismaClient`. The plugin recognizes any file that pulls
 * in one of these; targets whose file lacks the import are left unclassified so an
 * unrelated `db.user.findMany()` from another ORM does not get miscategorized.
 *
 * `@prisma/client` is the runtime import path Prisma Client uses since v4. The generated
 * client sits there regardless of how the schema was set up. Extensions / community
 * builds ship under distinct npm names — adding those is a table edit here.
 */
const PRISMA_CLIENT_MODULES: ReadonlySet<string> = new Set(["@prisma/client"])

/**
 * True when the file's import list contains any Prisma Client module. Empty import list
 * yields `false` — no false positives for files that reference the identifier but do
 * not actually import Prisma.
 */
export function hasPrismaImport(imports: readonly ImportEdge[]): boolean {
  return imports.some((edge) => PRISMA_CLIENT_MODULES.has(edge.source))
}

import type { ImportEdge } from "@aburi/types"

/**
 * npm module specifiers that expose a `PrismaClient`. Any file that pulls in one of
 * these is treated as a Prisma consumer; files that reference the identifier without
 * importing Prisma are ignored so an unrelated `db.user.findMany()` from another ORM
 * does not get miscategorized.
 *
 * - `@prisma/client` — the default Prisma Client entry since v4.
 * - `@prisma/client/edge` — the Edge runtime entry used by Vercel Edge, Cloudflare
 *   Workers, and Prisma Accelerate. Different bundle, same delegate surface.
 *
 * The set is a literal source of truth. Extending the plugin for community builds or a
 * future Prisma bundle is a table edit here.
 */
const PRISMA_CLIENT_MODULES: ReadonlySet<string> = new Set([
  "@prisma/client",
  "@prisma/client/edge",
])

/**
 * True when the file's import list contains any recognized Prisma Client module. An
 * empty source string on an ImportEdge is rejected: the language plugin's contract is
 * to emit normalized non-empty specifiers, and treating `""` as unmatched would silently
 * hide upstream bugs.
 */
export function hasPrismaImport(imports: readonly ImportEdge[]): boolean {
  return imports.some((edge) => {
    if (edge.source.length === 0) {
      throw new Error(
        "effects-prisma: ImportEdge.source is empty — language plugin emitted an unnormalized import edge",
      )
    }
    return PRISMA_CLIENT_MODULES.has(edge.source)
  })
}

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
const PRISMA_CLIENT_MODULES_LIST = ["@prisma/client", "@prisma/client/edge"] as const

export type PrismaClientModule = (typeof PRISMA_CLIENT_MODULES_LIST)[number]

export const PRISMA_CLIENT_MODULES: ReadonlySet<PrismaClientModule> = new Set(
  PRISMA_CLIENT_MODULES_LIST,
)

/**
 * True when the file's import list contains any recognized Prisma Client module. An
 * empty source string on an ImportEdge is rejected: the language plugin's contract is
 * to emit normalized non-empty specifiers, and treating `""` as unmatched would silently
 * hide upstream bugs.
 *
 * Validation runs across every edge before the match check so ImportEdge order does
 * not make throw behavior non-deterministic. Using `.some()` alone would short-circuit
 * on the first match and never notice a broken edge that happens to sit later.
 */
export function hasPrismaImport(imports: readonly ImportEdge[]): boolean {
  for (const edge of imports) {
    if (edge.source.length === 0) {
      throw new Error(
        "effects-prisma: ImportEdge.source is empty — language plugin emitted an unnormalized import edge",
      )
    }
  }
  return imports.some((edge) => (PRISMA_CLIENT_MODULES as ReadonlySet<string>).has(edge.source))
}

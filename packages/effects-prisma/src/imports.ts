import { hasMatchingImport } from "@aburi/plugin-registry/plugin-input"
import type { ImportEdge } from "@aburi/types"
import { EFFECTS_PRISMA_PLUGIN_NAME } from "./constants"

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

/** Membership test against the closed set of Prisma Client entry points. */
function isPrismaClientModule(source: string): boolean {
  return (PRISMA_CLIENT_MODULES as ReadonlySet<string>).has(source)
}

/**
 * True when the file's import list contains any recognized Prisma Client module. An
 * empty source string on an ImportEdge is rejected by the shared guard: the language
 * plugin's contract is to emit normalized non-empty specifiers, and treating `""` as
 * unmatched would silently hide upstream bugs.
 *
 * `filePath` is required and threaded into any thrown error message so a caught
 * exception in production tooling (CI logs, error reporters) points directly at the
 * offending source file rather than a bare "empty source" string.
 */
export function hasPrismaImport(imports: readonly ImportEdge[], filePath: string): boolean {
  return hasMatchingImport(
    imports,
    { plugin: EFFECTS_PRISMA_PLUGIN_NAME, filePath },
    isPrismaClientModule,
  )
}

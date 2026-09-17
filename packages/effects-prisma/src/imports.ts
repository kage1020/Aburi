import { hasMatchingImport } from "@aburi/plugin-registry/plugin-input"
import type { ImportEdge } from "@aburi/types"
import { EFFECTS_PRISMA_PLUGIN_NAME } from "./constants"

/**
 * Module specifiers that expose a `PrismaClient`: the default entry and the Edge runtime
 * entry (Vercel Edge, Cloudflare Workers, Accelerate) — a different bundle with the same
 * delegate surface. A closed set, since Prisma has only these two entry points.
 */
const PRISMA_CLIENT_MODULES_LIST = ["@prisma/client", "@prisma/client/edge"] as const

export type PrismaClientModule = (typeof PRISMA_CLIENT_MODULES_LIST)[number]

export const PRISMA_CLIENT_MODULES: ReadonlySet<PrismaClientModule> = new Set(
  PRISMA_CLIENT_MODULES_LIST,
)

function isPrismaClientModule(source: string): boolean {
  return (PRISMA_CLIENT_MODULES as ReadonlySet<string>).has(source)
}

/** True when the file imports a Prisma Client module; see `hasMatchingImport`. */
export function hasPrismaImport(imports: readonly ImportEdge[], filePath: string): boolean {
  return hasMatchingImport(
    imports,
    { plugin: EFFECTS_PRISMA_PLUGIN_NAME, filePath },
    isPrismaClientModule,
  )
}

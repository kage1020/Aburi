import type { ImportEdge } from "@aburi/types"

/**
 * The module specifier that marks a file as a Drizzle consumer. Drizzle exposes an
 * enormous driver-specific subpath surface — `drizzle-orm/node-postgres`,
 * `drizzle-orm/postgres-js`, `drizzle-orm/mysql2`, `drizzle-orm/better-sqlite3`,
 * `drizzle-orm/bun-sqlite`, `drizzle-orm/neon-http`, `drizzle-orm/neon-serverless`,
 * `drizzle-orm/d1`, `drizzle-orm/planetscale-serverless`, `drizzle-orm/libsql`,
 * `drizzle-orm/vercel-postgres`, `drizzle-orm/xata-http`, `drizzle-orm/tidb-serverless`,
 * `drizzle-orm/expo-sqlite`, `drizzle-orm/pglite`, `drizzle-orm/aws-data-api/*`, plus
 * `-proxy` variants — and adds new driver entry points per release.
 *
 * Rather than hardcode a closed allowlist (the pattern used by `@aburi/effects-prisma`,
 * where Prisma has only two entry points) we do a **prefix match**: exact
 * `"drizzle-orm"` or anything under `"drizzle-orm/"`. The trailing slash prevents
 * `drizzle-orm-mock` / `drizzle-orm-lite` and similar third-party lookalikes from
 * matching.
 */
const DRIZZLE_ROOT_MODULE = "drizzle-orm" as const
const DRIZZLE_SUBPATH_PREFIX = "drizzle-orm/" as const

/**
 * True when the file's import list contains any recognized Drizzle module. An empty
 * source string on an ImportEdge is rejected: the language plugin's contract is to emit
 * normalized non-empty specifiers, and treating `""` as unmatched would silently hide
 * upstream bugs.
 *
 * Validation runs across every edge before the match check so ImportEdge order does not
 * make throw behavior non-deterministic. Using `.some()` alone would short-circuit on
 * the first match and never notice a broken edge that happens to sit later.
 */
export function hasDrizzleImport(imports: readonly ImportEdge[]): boolean {
  for (const edge of imports) {
    if (edge.source.length === 0) {
      throw new Error(
        "effects-drizzle: ImportEdge.source is empty — language plugin emitted an unnormalized import edge",
      )
    }
  }
  return imports.some(
    (edge) => edge.source === DRIZZLE_ROOT_MODULE || edge.source.startsWith(DRIZZLE_SUBPATH_PREFIX),
  )
}

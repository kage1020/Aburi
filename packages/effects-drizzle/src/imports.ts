import { hasMatchingImport } from "@aburi/plugin-registry/plugin-input"
import type { ImportEdge } from "@aburi/types"
import { EFFECTS_DRIZZLE_PLUGIN_NAME } from "./constants"

/**
 * The module specifier that marks a file as a Drizzle consumer. Drizzle exposes a large
 * driver-specific subpath surface (`drizzle-orm/postgres-js`, `drizzle-orm/node-postgres`,
 * `drizzle-orm/d1`, `drizzle-orm/neon-http`, ...) and adds new driver entry points per
 * release.
 *
 * Rather than hardcode a closed allowlist (the pattern used by `@aburi/effects-prisma`,
 * where Prisma has only two entry points) we do a **prefix match**: exact
 * `"drizzle-orm"` or anything under `"drizzle-orm/"`. The trailing slash prevents
 * `drizzle-orm-mock` / `drizzle-orm-lite` and similar third-party lookalikes from
 * matching.
 */
const DRIZZLE_ROOT_MODULE = "drizzle-orm" as const
const DRIZZLE_SUBPATH_PREFIX = "drizzle-orm/" as const

/** Exact `drizzle-orm` or any of its driver subpaths. */
function isDrizzleModule(source: string): boolean {
  return source === DRIZZLE_ROOT_MODULE || source.startsWith(DRIZZLE_SUBPATH_PREFIX)
}

/**
 * True when the file's import list contains any recognized Drizzle module. An empty
 * source string on an ImportEdge is rejected by the shared guard: the language plugin's
 * contract is to emit normalized non-empty specifiers, and treating `""` as unmatched
 * would silently hide upstream bugs.
 *
 * `filePath` is required and threaded into any thrown error message so a caught
 * exception in production tooling (CI logs, error reporters) points directly at the
 * offending source file rather than a bare "empty source" string.
 */
export function hasDrizzleImport(imports: readonly ImportEdge[], filePath: string): boolean {
  return hasMatchingImport(
    imports,
    { plugin: EFFECTS_DRIZZLE_PLUGIN_NAME, filePath },
    isDrizzleModule,
  )
}

import { hasMatchingImport, matchesModuleOrSubpath } from "@aburi/plugin-registry/plugin-input"
import type { ImportEdge } from "@aburi/types"
import { EFFECTS_DRIZZLE_PLUGIN_NAME } from "./constants"

const isDrizzleModule = matchesModuleOrSubpath("drizzle-orm")

/** True when the file imports `drizzle-orm` or any of its subpaths; see `hasMatchingImport`. */
export function hasDrizzleImport(imports: readonly ImportEdge[], filePath: string): boolean {
  return hasMatchingImport(
    imports,
    { plugin: EFFECTS_DRIZZLE_PLUGIN_NAME, filePath },
    isDrizzleModule,
  )
}
